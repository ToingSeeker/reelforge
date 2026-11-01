// Which assets are motion graphics, and what made them (template + props). The file itself is
// an ordinary asset (a ProRes 4444 .mov the engine rendered); this is the recipe beside it.

import type { Database } from "./db.ts";
import { ProjectIdSchema } from "./schema.ts";
import { parse } from "./validate.ts";
import type { MotionProps, MotionRenderSpec, MotionTemplateId } from "./motion-catalog.ts";

export interface MotionGraphic {
  assetId: string;
  projectId: string;
  renderKey: string;
  template: MotionTemplateId;
  props: MotionProps;
  durationFrames: number;
  createdAt: string;
}

interface Row {
  asset_id: string;
  project_id: string;
  render_key: string;
  template: string;
  props: string;
  duration_frames: number;
  created_at: string;
}

const toGraphic = (r: Row): MotionGraphic => ({
  assetId: r.asset_id,
  projectId: r.project_id,
  renderKey: r.render_key,
  template: r.template as MotionTemplateId,
  props: JSON.parse(r.props) as MotionProps,
  durationFrames: r.duration_frames,
  createdAt: r.created_at,
});

export class MotionGraphicStore {
  readonly #db: Database;
  readonly #now: () => string;

  constructor(db: Database, opts: { now?: () => string } = {}) {
    this.#db = db;
    this.#now = opts.now ?? (() => new Date().toISOString());
  }

  /** Remember the recipe of a rendered asset. Re-recording the same asset keeps the first. */
  record(projectId: string, assetId: string, spec: MotionRenderSpec, durationFrames: number): MotionGraphic {
    const pid = parse(ProjectIdSchema, projectId);
    this.#db
      .prepare(
        `INSERT INTO motion_graphics (asset_id, project_id, render_key, template, props, duration_frames, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (asset_id) DO NOTHING`,
      )
      .run(assetId, pid, spec.key, spec.template, JSON.stringify(spec.props), durationFrames, this.#now());
    return toGraphic(this.#db.prepare("SELECT * FROM motion_graphics WHERE asset_id = ?").get(assetId) as unknown as Row);
  }

  list(projectId: string): MotionGraphic[] {
    const pid = parse(ProjectIdSchema, projectId);
    return (this.#db.prepare("SELECT * FROM motion_graphics WHERE project_id = ? ORDER BY created_at").all(pid) as unknown as Row[]).map(toGraphic);
  }
}
