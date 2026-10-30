import type { Workspace } from "./TopBar.tsx";

const COPY: Record<Exclude<Workspace, "edit" | "review">, { title: string; body: string; milestone: string }> = {
  automate: {
    title: "Automation Lab",
    body: "Workflow templates and automation pipelines that drive the same editing core as the CLI and MCP server.",
    milestone: "M5 — MCP & Automation",
  },
};

export function Placeholder({ workspace }: { workspace: Exclude<Workspace, "edit" | "review"> }) {
  const c = COPY[workspace];
  return (
    <main className="rf-center-state">
      <h1>{c.title}</h1>
      <p>{c.body}</p>
      <span className="rf-chip">{c.milestone}</span>
    </main>
  );
}

const RAIL_COPY: Record<string, { title: string; milestone: string }> = {
  templates: { title: "Templates", milestone: "Automation templates · M5" },
  text: { title: "Text & titles", milestone: "Captions & typography · M3" },
  audio: { title: "Audio tools", milestone: "Beat detection & mixing · M3" },
  effects: { title: "Effects", milestone: "Color & motion · after M2" },
  transitions: { title: "Transitions", milestone: "Basic dissolve · after M2" },
  color: { title: "Color", milestone: "Adjustments & LUTs · after M2" },
};

export function RailPlaceholder({ item }: { item: string }) {
  const c = RAIL_COPY[item] ?? { title: item, milestone: "" };
  return (
    <section className="rf-panel rf-library" aria-label={c.title}>
      <div className="rf-panel-head">
        <h2>{c.title}</h2>
      </div>
      <div className="rf-empty">
        <p className="rf-empty-body">Not built yet.</p>
        <span className="rf-chip">{c.milestone}</span>
      </div>
    </section>
  );
}
