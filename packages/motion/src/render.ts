// Renders one motion graphic with Remotion, as its own process (the engine spawns it; see
// packages/media/src/motion.ts). Kept out of the engine because Remotion brings a bundler, a
// headless Chrome and a native compositor.
//
// stdin: one JSON line { spec: MotionRenderSpec, output, cacheDir, bundleDir?, browserExecutable? }
// stdout: JSON lines {"progress": 0..1} … then {"done": true} or {"error": "…"} (exit 1)
//
// Output is ProRes 4444 with alpha (yuva444p10le): transparent where the graphic isn't, so it
// composites over the footage like any overlay clip.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CreateMotionInputSchema, motionLengthIssue, type MotionRenderSpec } from "@reelforge/core/motion-catalog";

interface Request {
  spec: MotionRenderSpec;
  output: string;
  cacheDir: string;
  /** A prebuilt Remotion bundle (the desktop app ships one); otherwise we bundle the sources. */
  bundleDir?: string;
  browserExecutable?: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const say = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);

/** Hash of the composition sources, so a dev bundle is rebuilt exactly when they change. */
function sourceHash(): string {
  const h = createHash("sha256");
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(tsx?|ttf)$/.test(e.name)) h.update(p).update(readFileSync(p));
    }
  };
  walk(here);
  h.update(readFileSync(join(here, "../../core/src/motion-catalog.ts")));
  return h.digest("hex").slice(0, 16);
}

async function serveUrl(req: Request): Promise<string> {
  if (req.bundleDir) {
    if (!existsSync(join(req.bundleDir, "index.html"))) throw new Error(`motion bundle missing at ${req.bundleDir}`);
    return req.bundleDir;
  }
  const out = join(req.cacheDir, "motion-bundle", sourceHash());
  if (existsSync(join(out, "index.html"))) return out;
  const { bundle } = await import("@remotion/bundler");
  const tmp = `${out}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  await bundle({ entryPoint: join(here, "entry.ts"), outDir: tmp, enableCaching: false });
  rmSync(out, { recursive: true, force: true });
  renameSync(tmp, out);
  return out;
}

async function main() {
  const line = await new Promise<string>((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        process.stdin.pause();
        resolve(buf.slice(0, nl));
      }
    });
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", reject);
  });
  const req = JSON.parse(line) as Request;
  const { spec } = req;
  // Never trust the caller with the props: they reach a browser page. spec.frames is the length plus a spare frame.
  const parsed = CreateMotionInputSchema.safeParse({ template: spec.template, props: spec.props, durationFrames: spec.frames - 1 });
  if (!parsed.success) throw new Error(`invalid motion graphic: ${parsed.error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ")}`);
  const tooLong = motionLengthIssue(spec.frames - 1, spec.fps);
  if (tooLong) throw new Error(tooLong);
  const checked = parsed.data;

  const url = await serveUrl(req);
  const { renderMedia, selectComposition } = await import("@remotion/renderer");
  const inputProps = {
    ...checked.props,
    frame: { width: spec.width, height: spec.height, fps: spec.fps.num / spec.fps.den, durationInFrames: spec.frames },
  };
  const browser = req.browserExecutable ? { browserExecutable: req.browserExecutable } : {};
  const composition = await selectComposition({ serveUrl: url, id: spec.template, inputProps, logLevel: "error", ...browser });
  mkdirSync(dirname(req.output), { recursive: true });
  const tmp = `${req.output}.${process.pid}.tmp.mov`;
  try {
    let last = -1;
    await renderMedia({
      serveUrl: url,
      composition,
      inputProps,
      codec: "prores",
      proResProfile: "4444",
      pixelFormat: "yuva444p10le",
      imageFormat: "png",
      muted: true,
      outputLocation: tmp,
      overwrite: true,
      logLevel: "error",
      ...browser,
      onProgress: ({ progress }) => {
        const p = Math.round(progress * 100) / 100;
        if (p !== last) say({ progress: (last = p) });
      },
    });
    renameSync(tmp, req.output);
  } finally {
    rmSync(tmp, { force: true });
  }
  say({ done: true });
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    say({ error: e instanceof Error ? e.message : String(e) });
    process.exit(1);
  },
);
