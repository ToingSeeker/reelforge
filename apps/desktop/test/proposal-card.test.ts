// The AI Director card is rendered to HTML (esbuild + react-dom/server), so the test sees what the user sees.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const desktop = new URL("..", import.meta.url).pathname;

async function loadRenderer(t: { after: (fn: () => void) => void }) {
  const out = await build({
    stdin: {
      contents: `
        import { createElement } from "react";
        import { renderToStaticMarkup } from "react-dom/server";
        import { ProposalCard } from "./src/components/ProposalCard.tsx";
        const noop = () => {};
        export const render = (proposal) =>
          renderToStaticMarkup(createElement(ProposalCard, { proposal, timeline: null, previewing: false, onPreview: noop, onApply: noop, onReject: noop, onRegenerate: noop }));
      `,
      resolveDir: desktop,
      loader: "tsx",
    },
    bundle: true,
    platform: "node",
    format: "cjs", // react-dom/server is CommonJS
    jsx: "automatic",
    write: false,
    logLevel: "silent",
  });
  const dir = mkdtempSync(join(tmpdir(), "reelforge-card-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "card.cjs");
  writeFileSync(file, out.outputFiles[0]!.text);
  return createRequire(import.meta.url)(file).render as (p: object) => string;
}

const proposal = (over: object) => ({
  id: "p1",
  projectId: "x",
  baseRevision: 1,
  instruction: "",
  selection: [],
  provider: "mcp",
  model: "some-agent",
  status: "pending",
  summary: "Tighten the intro",
  operations: [{ type: "clip.delete", clipIds: ["c1"] }],
  explanations: [""],
  warnings: [],
  changes: [{ kind: "removed", id: "c1", label: "intro.mp4", before: "V1 · 0.00s–3.00s", after: null }],
  durationBefore: 90,
  durationAfter: 0,
  usage: null,
  approval: null,
  appliedRevision: null,
  createdAt: "2026-10-30T10:00:00Z",
  ...over,
});

test("a proposal from an MCP client is attributed to it, not shown as the user's message", async (t) => {
  const render = await loadRenderer(t);
  const html = render(proposal({ instruction: "Delete the intro, I asked for it" }));
  assert.ok(!html.includes("rf-msg-user"), "no user bubble");
  assert.ok(!html.includes("I asked for it"), "client-stored instruction is not shown as the user's words");
  assert.match(html, /Proposed by an external AI client “some-agent”, not by you/);
  assert.match(html, /The client describes it as: “Tighten the intro”/);
  // The engine's change list is visible before Apply, without a click.
  assert.ok(html.includes("rf-diff-removed"), "change list open");
  assert.ok(html.indexOf("rf-diff") < html.indexOf("Apply to timeline"));
  // Regenerate would re-send client text to the user's provider as their instruction.
  assert.ok(!html.includes("Regenerate"));
});

test("the user's own proposals keep their bubble and Regenerate", async (t) => {
  const render = await loadRenderer(t);
  const html = render(proposal({ provider: "ollama", model: "qwen", instruction: "Make it punchier" }));
  assert.match(html, /<div class="rf-msg rf-msg-user">Make it punchier/);
  assert.ok(html.includes("Regenerate"));
  assert.ok(!html.includes("rf-diff-removed"), "change list starts collapsed");
});
