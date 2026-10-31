const RAIL_COPY: Record<string, { title: string; milestone: string }> = {
  templates: { title: "Templates", milestone: "Automation templates · M5" },
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
