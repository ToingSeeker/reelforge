import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CreateMotionInputSchema,
  MOTION_TEMPLATE_IDS,
  MOTION_TEMPLATES,
  motionRenderSpec,
  openDatabase,
  parse,
  ProjectStore,
  TimelineStore,
  type TimelineOp,
} from "@reelforge/core";
import { createRenderJob, ensureProxy, importMedia, motionAvailable, RenderRunner, renderMotion } from "../src/index.ts";
import { hasAlphaPixFmt } from "../src/probe.ts";

const ff = (args: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
const dir = realpathSync(mkdtempSync(join(tmpdir(), "reelforge-motion-")));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const src = (n: string) => join(dir, n);

// A ProRes 4444 overlay: opaque blue on the left half, fully transparent on the right.
ff([
  "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=30:d=2,format=yuva444p10le,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='if(lt(X,W/2),1023,0)'",
  "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", src("half.mov"),
]);
ff(["-f", "lavfi", "-i", "color=c=red:s=320x180:r=30:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", src("red.mp4")]);
ff(["-f", "lavfi", "-i", "color=c=0x00ff00@0.0:s=64x64,format=rgba", "-frames:v", "1", src("clear.png")]);

function pixel(file: string, frame: number, x: number, y: number, fmt = "rgb24", n = 3): number[] {
  const out = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-vf", `select=eq(n\\,${frame}),format=${fmt},crop=1:1:${x}:${y}`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", fmt, "-"]);
  return [...out.subarray(0, n)];
}
const near = (a: number[], b: number[], tol = 24) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);

function setup(t: { after: (fn: () => unknown) => void }) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "reelforge-motion-db-")));
  const db = openDatabase(join(home, "db.sqlite"));
  t.after(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });
  const project = new ProjectStore(db).create({ name: "Motion", settings: { width: 320, height: 180, fps: { num: 30, den: 1 } } }, "cli");
  return { db, home, project };
}

test("alpha pixel formats are recognised", () => {
  for (const f of ["yuva444p10le", "yuva444p12le", "rgba", "bgra", "ya8", "gbrap10le", "yuva420p"]) assert.ok(hasAlphaPixFmt(f), f);
  for (const f of ["yuv420p", "yuv444p12le", "rgb24", "gray", "nv12", undefined]) assert.ok(!hasAlphaPixFmt(f), String(f));
});

test("import flags alpha sources; packed proxy keeps the alpha below the picture", async (t) => {
  const { db, home, project } = setup(t);
  const r = await importMedia(db, project.id, [src("half.mov"), src("red.mp4"), src("clear.png")], "cli");
  const [half, red, clear] = r.imported;
  assert.deepEqual([half?.hasAlpha, red?.hasAlpha, clear?.hasAlpha], [true, false, true]);

  const proxy = await ensureProxy(db, join(home, "cache"), half!.id, half!.sourcePath, "video", true);
  const [w, h] = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", proxy]).toString().trim().split(",").map(Number);
  assert.equal(h, (w! * 180 / 320) * 2, "colour on top, alpha below: twice the height");
  const k = w! / 320;
  // Decoded as a browser would (TV range expanded to full): opaque left ≈ 255, transparent right = 0.
  const alphaAt = (x: number) => pixel(proxy, 10, Math.round(x * k), Math.round(270 * k), "gray", 1)[0]!;
  assert.ok(alphaAt(40) >= 245, `opaque alpha ${alphaAt(40)}`);
  assert.ok(alphaAt(280) <= 8, `clear alpha ${alphaAt(280)}`);
  assert.ok(near(pixel(proxy, 10, Math.round(40 * k), Math.round(90 * k)), [0, 0, 255], 40), "colour half is the picture");

  const still = await ensureProxy(db, join(home, "cache"), clear!.id, clear!.sourcePath, "image", true);
  assert.ok(still.endsWith(".png"), "transparent stills get a PNG proxy, not a JPEG");
  assert.equal(pixel(still, 0, 10, 10, "rgba", 4)[3], 0);
});

test("export and preview composite an alpha overlay over the footage", async (t) => {
  const { db, home, project } = setup(t);
  const r = await importMedia(db, project.id, [src("red.mp4"), src("half.mov")], "cli");
  const [red, half] = r.imported;
  const timeline = new TimelineStore(db);
  const tl = timeline.get(project.id);
  const v1 = tl.tracks.find((x) => x.kind === "video")!.id;
  const v2 = tl.tracks.find((x) => x.kind === "overlay")!.id;
  const ops: TimelineOp[] = [
    { type: "clip.add", trackId: v1, assetId: red!.id, start: 0, duration: 30 },
    { type: "clip.add", trackId: v2, assetId: half!.id, start: 0, duration: 30 },
  ];
  timeline.apply(project.id, { baseRevision: tl.project.revision, operations: ops }, "cli");

  const runner = new RenderRunner(db, { cacheDir: join(home, "cache") });
  runner.start();
  t.after(() => runner.stop());
  for (const kind of ["export", "preview"] as const) {
    const job = createRenderJob(db, project.id, kind, kind === "export" ? join(home, "export.mp4") : undefined);
    runner.enqueue(job.id);
    const done = await runner.wait(job.id);
    assert.equal(done.state, "completed", `${kind}: ${JSON.stringify(done.error)}`);
    const file = done.outputPath!;
    const [w] = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width", "-of", "csv=p=0", file]).toString().trim().split(",").map(Number);
    const k = w! / 320;
    assert.ok(near(pixel(file, 15, Math.round(40 * k), Math.round(90 * k)), [0, 0, 255], 40), `${kind}: opaque half covers the footage`);
    assert.ok(near(pixel(file, 15, Math.round(280 * k), Math.round(90 * k)), [255, 0, 0], 40), `${kind}: footage shows through the clear half`);
  }
});

test("motion inputs are validated against the template", () => {
  const ok = parse(CreateMotionInputSchema, { template: "lower-third", props: MOTION_TEMPLATES["lower-third"].defaults, durationFrames: 150 });
  assert.equal(ok.template, "lower-third");
  for (const id of MOTION_TEMPLATE_IDS) parse(CreateMotionInputSchema, { template: id, props: MOTION_TEMPLATES[id].defaults, durationFrames: 30 });
  const bad = [
    { template: "nope", props: {}, durationFrames: 30 },
    { template: "badge", props: { ...MOTION_TEMPLATES.badge.defaults, accent: "red" }, durationFrames: 30 },
    { template: "badge", props: { ...MOTION_TEMPLATES.badge.defaults, script: "<x>" }, durationFrames: 30 },
    { template: "badge", props: { ...MOTION_TEMPLATES.badge.defaults, text: "" }, durationFrames: 30 },
    { template: "badge", props: MOTION_TEMPLATES.badge.defaults, durationFrames: 0 },
  ];
  for (const b of bad) assert.throws(() => parse(CreateMotionInputSchema, b), /./, JSON.stringify(b));

  const settings = { width: 1080, height: 1920, fps: { num: 30, den: 1 } };
  const a = motionRenderSpec(ok, settings);
  assert.equal(a.key, motionRenderSpec(ok, settings).key, "same input, same file");
  assert.notEqual(a.key, motionRenderSpec({ ...ok, props: { ...ok.props, name: "Sam" } as never }, settings).key);
  assert.notEqual(a.key, motionRenderSpec(ok, { ...settings, width: 1920, height: 1080 }).key);
  assert.equal(a.frames, 151, "one spare frame so the probed length never comes up short");
});

test("Remotion renders a template to ProRes 4444 with alpha at the project size", { skip: !motionAvailable().ok && "motion renderer not installed", timeout: 300_000 }, async (t) => {
  const { home } = setup(t);
  const input = parse(CreateMotionInputSchema, { template: "badge", props: MOTION_TEMPLATES.badge.defaults, durationFrames: 20 });
  const spec = motionRenderSpec(input, { width: 640, height: 360, fps: { num: 30, den: 1 } });
  const progress: number[] = [];
  // A stable bundle cache, so re-runs don't re-bundle the compositions.
  const out = await renderMotion(spec, { generatedDir: join(home, "generated"), cacheDir: join(tmpdir(), "reelforge-test-motion-cache"), onProgress: (p) => progress.push(p) });
  assert.ok(existsSync(out));
  const info = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", out]).toString()) as { streams: { codec_name: string; pix_fmt: string; width: number; height: number; nb_frames: string }[] };
  const v = info.streams[0]!;
  assert.deepEqual([v.codec_name, v.width, v.height, Number(v.nb_frames)], ["prores", 640, 360, 21]);
  assert.ok(hasAlphaPixFmt(v.pix_fmt), v.pix_fmt);
  assert.equal(progress.at(-1), 1);
  // Top-right badge: drawn there once it has popped in, transparent in the opposite corner.
  assert.ok(pixel(out, 15, 600, 40, "rgba", 4)[3]! > 200, "badge is opaque in its corner");
  assert.equal(pixel(out, 15, 20, 330, "rgba", 4)[3], 0, "rest of the frame is clear");
  // Rendering the same spec again reuses the file.
  const again = await renderMotion(spec, { generatedDir: join(home, "generated"), cacheDir: join(tmpdir(), "reelforge-test-motion-cache") });
  assert.equal(again, out);
});
