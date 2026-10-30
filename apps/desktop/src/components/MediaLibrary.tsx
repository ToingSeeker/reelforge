import { useState } from "react";
import { Icon } from "../icons.tsx";

const FILTERS = ["All", "Video", "Audio", "Image"] as const;

export function MediaLibrary() {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("All");
  return (
    <section className="rf-panel rf-library" aria-label="Media library">
      <div className="rf-panel-head">
        <h2>Media Library</h2>
        <button className="rf-btn" disabled title="Import — arrives with the media engine (M1)">
          <Icon name="plus" size={15} /> Import
        </button>
      </div>
      <label className="rf-search">
        <Icon name="search" size={15} />
        <input placeholder="Search media…" aria-label="Search media" disabled />
      </label>
      <div className="rf-segmented" role="tablist" aria-label="Media type">
        {FILTERS.map((f) => (
          <button key={f} role="tab" aria-selected={filter === f} onClick={() => setFilter(f)}>
            {f}
          </button>
        ))}
      </div>
      <div className="rf-empty">
        <div className="rf-empty-icon">
          <Icon name="film" size={26} />
        </div>
        <p className="rf-empty-title">No media yet</p>
        <p className="rf-empty-body">Import MP4, MOV, JPEG, PNG, WAV or MP3. Originals are only ever read, never modified.</p>
        <span className="rf-chip">Media import · M1</span>
      </div>
    </section>
  );
}
