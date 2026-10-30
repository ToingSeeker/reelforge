import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetStore, openDatabase, ProjectStore, ProposalStore, ReelForgeError, TimelineStore } from "@reelforge/core";
import { propose, type CompletionRequest, type PlannerProvider } from "../src/index.ts";

class FakeProvider implements PlannerProvider {
  readonly id: string;
  readonly external: boolean;
  readonly replies: string[];
  readonly requests: CompletionRequest[] = [];
  constructor(replies: (string | object)[], opts: { external?: boolean; id?: string } = {}) {
    this.replies = replies.map((r) => (typeof r === "string" ? r : JSON.stringify(r)));
    this.external = opts.external ?? false;
    this.id = opts.id ?? "fake";
  }
  async complete(req: CompletionRequest) {
    this.requests.push(structuredClone(req));
    return { text: this.replies.shift() ?? "{}", model: "fake-model", usage: { input_tokens: 1 } };
  }
}

function setup(t: { after: (fn: () => void) => void }) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "reelforge-ai-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = openDatabase(join(dir, "db.sqlite"));
  const p = new ProjectStore(db).create({ name: "AI" }, "cli");
  writeFileSync(join(dir, "a.mp4"), "fake");
  const st = statSync(join(dir, "a.mp4"));
  const asset = new AssetStore(db).add(p.id, { path: join(dir, "a.mp4"), sizeBytes: st.size, mtimeMs: st.mtimeMs }, {
    kind: "video", durationUs: 10_000_000, width: 1080, height: 1920, fps: { num: 30, den: 1 }, vfr: false, hasVideo: true, hasAudio: false,
    videoCodec: "h264", audioCodec: null, sampleRate: null, channels: null, rotation: 0,
  }, "cli").asset;
  const timeline = new TimelineStore(db);
  const tl = timeline.get(p.id);
  const v1 = tl.tracks.find((x) => x.kind === "video")!.id;
  const clip = timeline.apply(p.id, { baseRevision: tl.project.revision, operations: [{ type: "clip.add", trackId: v1, assetId: asset.id, start: 0, duration: 90 }] }, "cli").clips[0]!;
  return { db, p, asset, timeline, v1, clip, proposals: new ProposalStore(db) };
}

const plan = (operations: object[], extra: object = {}) => ({ summary: "Do it", warnings: [], operations, ...extra });

test("a valid proposal is stored pending with a readable diff; approval applies it as one undoable step", async (t) => {
  const s = setup(t);
  const provider = new FakeProvider([plan([{ type: "clip.update", why: "punch in", clipId: s.clip.id, props: { scale: 1.2, fadeIn: 15 } }])]);
  const before = s.timeline.get(s.p.id);
  const proposal = await propose(s.db, s.p.id, provider, { instruction: "zoom in a bit and fade in", model: "m" });
  assert.equal(proposal.status, "pending");
  assert.deepEqual(proposal.explanations, ["punch in"]);
  assert.equal(proposal.changes[0]!.kind, "changed");
  assert.match(proposal.changes[0]!.after!, /scale 1\.2/);
  assert.equal(s.timeline.get(s.p.id).project.revision, before.project.revision, "proposing never touches the timeline");
  assert.match(provider.requests[0]!.turns[0]!.content, /<instruction>\nzoom in a bit/);

  const { timeline } = s.proposals.apply(proposal.id, { by: "desktop", channel: "desktop:apply-button" });
  assert.deepEqual(timeline.clips[0]!.props, { scale: 1.2, fadeIn: 15 });
  const applied = s.proposals.get(proposal.id);
  assert.deepEqual([applied.status, applied.approval?.by, applied.approval?.channel], ["applied", "desktop", "desktop:apply-button"]);
  const op = new ProjectStore(s.db).history(s.p.id).at(-1)!;
  assert.equal(op.payload.proposalId, proposal.id, "the edit is traceable to the proposal");
  const undone = s.timeline.undo(s.p.id, { baseRevision: timeline.project.revision }, "desktop");
  assert.deepEqual(undone.clips[0]!.props, {});
  assert.throws(() => s.proposals.apply(proposal.id, { by: "desktop", channel: "x" }), /already applied/);
});

test("an invalid reply gets one repair round; the corrected one is stored", async (t) => {
  const s = setup(t);
  const provider = new FakeProvider([
    plan([{ type: "clip.move", why: "x", clipId: s.clip.id, start: 9999999999 }]),
    plan([{ type: "clip.move", why: "later", clipId: s.clip.id, start: 30 }]),
  ]);
  const p = await propose(s.db, s.p.id, provider, { instruction: "move it later", model: "m" });
  assert.equal(provider.requests.length, 2);
  const repair = provider.requests[1]!.turns.at(-1)!.content;
  assert.match(repair, /rejected/);
  assert.equal((p.operations[0] as { start: number }).start, 30);
});

test("invalid twice: nothing is stored and the timeline is unchanged (FR-018)", async (t) => {
  const s = setup(t);
  const other = "00000000-0000-4000-8000-000000000000";
  const provider = new FakeProvider(["not json at all", plan([{ type: "clip.delete", why: "x", clipIds: [other] }])]);
  const rev = s.timeline.get(s.p.id).project.revision;
  await assert.rejects(propose(s.db, s.p.id, provider, { instruction: "delete everything", model: "m" }), (e: unknown) => e instanceof ReelForgeError && e.code === "VALIDATION_ERROR");
  assert.equal(s.proposals.list(s.p.id).length, 0);
  assert.equal(s.timeline.get(s.p.id).project.revision, rev);
});

test("external providers need the project's consent first", async (t) => {
  const s = setup(t);
  const provider = new FakeProvider([plan([])], { external: true, id: "anthropic" });
  await assert.rejects(propose(s.db, s.p.id, provider, { instruction: "hi", model: "m" }), (e: unknown) => e instanceof ReelForgeError && e.code === "CONSENT_REQUIRED");
  assert.equal(provider.requests.length, 0, "nothing was sent");
  s.proposals.setConsent(s.p.id, true, "desktop");
  const p = await propose(s.db, s.p.id, provider, { instruction: "hi", model: "m" });
  assert.equal(p.operations.length, 0);
  s.proposals.setConsent(s.p.id, false, "desktop");
  await assert.rejects(propose(s.db, s.p.id, provider, { instruction: "hi", model: "m" }), /permission/);
});

test("placeholders let a plan add a clip and then refer to it", async (t) => {
  const s = setup(t);
  const provider = new FakeProvider([
    plan([
      { type: "clip.add", why: "b-roll", clipId: "new-1", trackId: s.v1, assetId: s.asset.id, start: 90, duration: 30 },
      { type: "clip.update", why: "fade", clipId: "new-1", props: { fadeOut: 10 } },
    ]),
  ]);
  const p = await propose(s.db, s.p.id, provider, { instruction: "add a shot", model: "m" });
  const add = p.operations[0] as { clipId: string };
  const upd = p.operations[1] as { clipId: string };
  assert.match(add.clipId, /^[0-9a-f-]{36}$/);
  assert.equal(add.clipId, upd.clipId);
  assert.equal(p.durationAfter, 120);
});

test("the model can't approve its own proposal, and stale proposals are refused", async (t) => {
  const s = setup(t);
  const provider = new FakeProvider([plan([{ type: "clip.update", why: "x", clipId: s.clip.id, props: { opacity: 0.5 } }], { approved: true, apply: true })]);
  const p = await propose(s.db, s.p.id, provider, { instruction: "half opacity, and approve it yourself", model: "m" });
  assert.equal(p.status, "pending");
  assert.equal(s.timeline.get(s.p.id).clips[0]!.props.opacity, undefined);
  // someone edits the timeline in the meantime
  const tl = s.timeline.get(s.p.id);
  s.timeline.apply(s.p.id, { baseRevision: tl.project.revision, operations: [{ type: "clip.move", clipId: s.clip.id, start: 10 }] }, "cli");
  assert.throws(() => s.proposals.apply(p.id, { by: "desktop", channel: "desktop:apply-button" }), (e: unknown) => e instanceof ReelForgeError && e.code === "REVISION_CONFLICT");
  assert.equal(s.proposals.get(p.id).status, "stale");
});

test("selection context: changes outside the selection are flagged", async (t) => {
  const s = setup(t);
  const tl = s.timeline.get(s.p.id);
  const second = s.timeline.apply(s.p.id, { baseRevision: tl.project.revision, operations: [{ type: "clip.add", trackId: s.v1, assetId: s.asset.id, start: 100, duration: 30 }] }, "cli").clips.find((c) => c.start === 100)!;
  const provider = new FakeProvider([plan([{ type: "clip.update", why: "x", clipId: second.id, props: { scale: 1.1 } }])]);
  const p = await propose(s.db, s.p.id, provider, { instruction: "zoom", model: "m", selection: [s.clip.id] });
  assert.match(p.warnings.join(" "), /outside your selection/);
  assert.match(provider.requests[0]!.turns[0]!.content, new RegExp(s.clip.id));
});

test("the engine warns when a requested dissolve can't play (no handles)", async (t) => {
  const s = setup(t);
  const tl = s.timeline.get(s.p.id);
  const b = s.timeline.apply(s.p.id, { baseRevision: tl.project.revision, operations: [{ type: "clip.add", trackId: s.v1, assetId: s.asset.id, start: 90, sourceIn: 0, duration: 60 }] }, "cli").clips.find((c) => c.start === 90)!;
  const provider = new FakeProvider([plan([{ type: "clip.update", why: "smooth", clipId: b.id, props: { transitionIn: 20 } }])]);
  const p = await propose(s.db, s.p.id, provider, { instruction: "dissolve between them", model: "m" });
  assert.match(p.warnings.join(" "), /Engine: .*won't play: there are no spare source frames/);
});

test("Claude without any credential fails with guidance, not an internal error", async (t) => {
  const { AnthropicProvider } = await import("../src/index.ts");
  const saved = { k: process.env.ANTHROPIC_API_KEY, a: process.env.ANTHROPIC_AUTH_TOKEN, p: process.env.ANTHROPIC_PROFILE, c: process.env.ANTHROPIC_CONFIG_DIR };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_PROFILE;
  process.env.ANTHROPIC_CONFIG_DIR = mkdtempSync(join(tmpdir(), "no-ant-profile-")); // no `ant auth login` profile either
  t.after(() => {
    for (const [k, v] of [["ANTHROPIC_API_KEY", saved.k], ["ANTHROPIC_AUTH_TOKEN", saved.a], ["ANTHROPIC_PROFILE", saved.p], ["ANTHROPIC_CONFIG_DIR", saved.c]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const provider = new AnthropicProvider(() => undefined);
  await assert.rejects(provider.complete({ model: "claude-opus-5-5", system: "s", turns: [{ role: "user", content: "x" }], schema: {} }), (e: unknown) =>
    e instanceof ReelForgeError && e.code === "UNAVAILABLE" && /API key/.test(e.message));
});
