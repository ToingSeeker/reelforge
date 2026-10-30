import { Icon } from "../icons.tsx";

const PLAN_FIELDS = ["Scenes", "Captions", "Music Sync", "Color Grade", "Aspect Ratio"];

export function AIDirector() {
  return (
    <aside className="rf-panel rf-director" aria-label="AI Director">
      <div className="rf-director-head">
        <span className="rf-director-mark">
          <Icon name="sparkle" size={22} />
        </span>
        <div>
          <h2>AI Director</h2>
          <p>Your creative copilot for video editing</p>
        </div>
        <button className="rf-btn rf-btn-ghost" disabled title="Provider selection arrives in M4">
          Model: none <Icon name="chevronDown" size={14} />
        </button>
      </div>

      <div className="rf-director-body">
        <div className="rf-director-intro">
          <p className="rf-empty-title">Describe it. Edit it. Ship it.</p>
          <p className="rf-empty-body">
            The AI Director will turn an instruction into a structured edit proposal: every change validated, previewed as a diff,
            and applied to the timeline only after you approve it. Nothing is applied on the AI's word alone.
          </p>
          <ul className="rf-plan-skeleton" aria-label="What a proposal contains">
            {PLAN_FIELDS.map((f) => (
              <li key={f}>
                <span>{f}</span>
                <span className="rf-skeleton-bar" />
              </li>
            ))}
          </ul>
          <span className="rf-chip">AI Director · M4</span>
        </div>
      </div>

      <form className="rf-director-input" onSubmit={(e) => e.preventDefault()}>
        <input placeholder="Tell me what to edit, add, or change…" aria-label="Instruction for the AI Director" disabled />
        <button className="rf-send" disabled aria-label="Send">
          <Icon name="send" size={17} />
        </button>
      </form>
    </aside>
  );
}
