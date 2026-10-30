import type { Workspace } from "./TopBar.tsx";

const COPY: Record<Exclude<Workspace, "edit">, { title: string; body: string; milestone: string }> = {
  automate: {
    title: "Automation Lab",
    body: "Workflow templates and automation pipelines that drive the same editing core as the CLI and MCP server.",
    milestone: "M5 — MCP & Automation",
  },
  review: {
    title: "Review & Export",
    body: "Proposal review, version comparison and the render queue (MP4 · H.264 · AAC).",
    milestone: "M2 render · M4 proposals",
  },
};

export function Placeholder({ workspace }: { workspace: Exclude<Workspace, "edit"> }) {
  const c = COPY[workspace];
  return (
    <main className="rf-center-state">
      <h1>{c.title}</h1>
      <p>{c.body}</p>
      <span className="rf-chip">{c.milestone}</span>
    </main>
  );
}
