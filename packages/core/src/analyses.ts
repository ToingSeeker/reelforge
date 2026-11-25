import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import type { Database } from "./db.ts";
import { ReelForgeError } from "./errors.ts";
import { AssetStore } from "./assets.ts";
import { ANALYSIS_KINDS, ProjectIdSchema, type Analysis, type Asset, type AnalysisKind, type AnalysisResults, type AnalysisState } from "./schema.ts";
import { parse } from "./validate.ts";

/** The analyses that make sense for an asset: scenes need a picture that moves, beats and transcripts need sound. */
export function applicableAnalysisKinds(asset: Pick<Asset, "kind" | "hasAudio">): AnalysisKind[] {
  return ANALYSIS_KINDS.filter((k) => (k === "scenes" ? asset.kind === "video" : asset.hasAudio));
}

/** Transcription languages: an ISO 639 code (en, id, deu) or "auto" to detect it. */
export const TRANSCRIPT_LANGUAGE = /^(auto|[a-z]{2,3})$/;

export function checkTranscriptLanguage(language: unknown): string {
  if (typeof language !== "string" || !TRANSCRIPT_LANGUAGE.test(language)) {
    throw new ReelForgeError("VALIDATION_ERROR", `invalid language "${String(language).slice(0, 40)}" (use an ISO code like en, id or de, or auto)`);
  }
  return language;
}

interface AnalysisRow {
  id: string;
  asset_id: string;
  kind: AnalysisKind;
  state: AnalysisState;
  progress: number;
  engine: string | null;
  params: string;
  result: string | null;
  error: string | null;
  source_size: number;
  runner_pid: number | null;
  created_at: string;
  finished_at: string | null;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Per-asset analysis results and their job state (shared by every process via SQLite). */
export class AnalysisStore {
  readonly #db: Database;
  readonly #now: () => string;

  constructor(db: Database, opts: { now?: () => string } = {}) {
    this.#db = db;
    this.#now = opts.now ?? (() => new Date().toISOString());
  }

  #toAnalysis(r: AnalysisRow, currentSize: number | null): Analysis {
    return {
      id: r.id,
      assetId: r.asset_id,
      kind: r.kind,
      state: r.state,
      progress: r.progress,
      engine: r.engine,
      params: JSON.parse(r.params) as Record<string, unknown>,
      result: r.result ? (JSON.parse(r.result) as Analysis["result"]) : null,
      error: r.error,
      stale: currentSize !== null && currentSize !== r.source_size,
      createdAt: r.created_at,
      finishedAt: r.finished_at,
    };
  }

  #size(path: string): number | null {
    try {
      return statSync(path).size;
    } catch {
      return null;
    }
  }

  list(projectId: string, assetId: string): Analysis[] {
    const asset = new AssetStore(this.#db).get(projectId, assetId);
    const rows = this.#db.prepare("SELECT * FROM analyses WHERE asset_id = ? ORDER BY kind").all(asset.id) as unknown as AnalysisRow[];
    const size = this.#size(asset.sourcePath);
    return rows.map((r) => this.#toAnalysis(r, size));
  }

  /** Every analysis of every asset in a project, keyed by asset id. */
  forProject(projectId: string): Map<string, Analysis[]> {
    const pid = parse(ProjectIdSchema, projectId);
    const rows = this.#db
      .prepare("SELECT a.*, s.source_path FROM analyses a JOIN assets s ON s.id = a.asset_id WHERE s.project_id = ?")
      .all(pid) as unknown as (AnalysisRow & { source_path: string })[];
    const out = new Map<string, Analysis[]>();
    for (const r of rows) out.set(r.asset_id, [...(out.get(r.asset_id) ?? []), this.#toAnalysis(r, this.#size(r.source_path))]);
    return out;
  }

  latest<K extends AnalysisKind>(projectId: string, assetId: string, kind: K): Analysis<K> | null {
    return (this.list(projectId, assetId).find((a) => a.kind === kind) as Analysis<K> | undefined) ?? null;
  }

  get(id: string): Analysis {
    const row = this.#db.prepare("SELECT a.*, s.source_path FROM analyses a JOIN assets s ON s.id = a.asset_id WHERE a.id = ?").get(id) as unknown as
      | (AnalysisRow & { source_path: string })
      | undefined;
    if (!row) throw new ReelForgeError("NOT_FOUND", `analysis ${id} not found`, { analysisId: id });
    return this.#toAnalysis(row, this.#size(row.source_path));
  }

  /** Queue (or re-queue) analyses. A running one is left alone; everything else restarts from scratch. */
  enqueue(projectId: string, assetId: string, kinds: readonly AnalysisKind[], params: Record<string, unknown> = {}): Analysis[] {
    const asset = new AssetStore(this.#db).get(projectId, assetId);
    if (asset.status === "missing") throw new ReelForgeError("VALIDATION_ERROR", `${asset.filename} is offline; relink it before analysing`, { assetId });
    if (params.language !== undefined) checkTranscriptLanguage(params.language);
    for (const kind of kinds) {
      if (!ANALYSIS_KINDS.includes(kind)) throw new ReelForgeError("VALIDATION_ERROR", `unknown analysis kind "${kind}"`);
      if (kind === "beats" && !asset.hasAudio) throw new ReelForgeError("VALIDATION_ERROR", `${asset.filename} has no audio to find beats in`, { assetId });
      if (kind === "transcript" && !asset.hasAudio) throw new ReelForgeError("VALIDATION_ERROR", `${asset.filename} has no audio to transcribe`, { assetId });
      if (kind === "scenes" && asset.kind !== "video") throw new ReelForgeError("VALIDATION_ERROR", `scene detection needs a video (${asset.filename} is ${asset.kind})`, { assetId });
      this.#db
        .prepare(
          `INSERT INTO analyses (id, asset_id, kind, state, params, source_size, created_at) VALUES (?, ?, ?, 'queued', ?, ?, ?)
           ON CONFLICT (asset_id, kind) DO UPDATE SET state = 'queued', progress = 0, result = NULL, error = NULL, engine = NULL,
             params = excluded.params, source_size = excluded.source_size, runner_pid = NULL, created_at = excluded.created_at, finished_at = NULL
           WHERE analyses.state <> 'running'`,
        )
        .run(randomUUID(), asset.id, kind, JSON.stringify(params), asset.sizeBytes, this.#now());
    }
    return this.list(projectId, assetId).filter((a) => kinds.includes(a.kind));
  }

  queued(): string[] {
    return (this.#db.prepare("SELECT id FROM analyses WHERE state = 'queued' ORDER BY created_at, rowid").all() as { id: string }[]).map((r) => r.id);
  }

  claim(id: string, pid: number = process.pid): boolean {
    return Number(this.#db.prepare("UPDATE analyses SET state = 'running', runner_pid = ? WHERE id = ? AND state = 'queued'").run(pid, id).changes) === 1;
  }

  progress(id: string, progress: number): void {
    this.#db.prepare("UPDATE analyses SET progress = ? WHERE id = ? AND state = 'running'").run(Math.max(0, Math.min(1, progress)), id);
  }

  complete<K extends AnalysisKind>(id: string, engine: string, result: AnalysisResults[K]): Analysis {
    this.#db
      .prepare("UPDATE analyses SET state = 'completed', progress = 1, engine = ?, result = ?, finished_at = ? WHERE id = ? AND state = 'running'")
      .run(engine, JSON.stringify(result), this.#now(), id);
    return this.get(id);
  }

  fail(id: string, message: string): Analysis {
    this.#db
      .prepare("UPDATE analyses SET state = 'failed', error = ?, finished_at = ? WHERE id = ? AND state IN ('queued', 'running')")
      .run(message.slice(0, 2000), this.#now(), id);
    return this.get(id);
  }

  recoverInterrupted(): number {
    const rows = this.#db.prepare("SELECT id, runner_pid FROM analyses WHERE state = 'running'").all() as { id: string; runner_pid: number | null }[];
    const dead = rows.filter((r) => !r.runner_pid || !pidAlive(r.runner_pid));
    for (const r of dead) this.fail(r.id, "the analysis process stopped before finishing; run it again");
    return dead.length;
  }
}
