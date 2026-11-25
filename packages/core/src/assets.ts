import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { basename } from "node:path";
import type { Database } from "./db.ts";
import { ReelForgeError } from "./errors.ts";
import { commitRevision } from "./revisions.ts";
import { transaction } from "./db.ts";
import { ProjectIdSchema, type Actor, type Asset, type AssetFile, type AssetProbe } from "./schema.ts";
import { microsToFrames, type Rational } from "./timebase.ts";
import { parse } from "./validate.ts";

interface AssetRow {
  id: string;
  project_id: string;
  kind: Asset["kind"];
  source_path: string;
  filename: string;
  size_bytes: number;
  mtime_ms: number;
  duration_us: number | null;
  width: number | null;
  height: number | null;
  fps_num: number | null;
  fps_den: number | null;
  vfr: number;
  has_video: number;
  has_audio: number;
  has_alpha: number;
  video_codec: string | null;
  audio_codec: string | null;
  sample_rate: number | null;
  channels: number | null;
  rotation: number;
  created_at: string;
}

function fileStatus(r: AssetRow): Asset["status"] {
  try {
    const st = statSync(r.source_path);
    if (!st.isFile()) return "missing";
    return st.size === r.size_bytes && Math.floor(st.mtimeMs) === r.mtime_ms ? "online" : "changed";
  } catch {
    return "missing";
  }
}

/**
 * Whole frames in a probed media duration. Containers often report a hair less than
 * frames × frame time (a 4-frame MP4 says 0.133008 s, not 0.133333 s), so a shortfall
 * under a tenth of a frame still counts as the frame: flooring it would lose the last
 * frame, and leave a 1-frame file with no usable length.
 */
export function mediaFrames(durationUs: number, fps: Rational): number {
  const tenthOfFrame = (100_000 * fps.den) / fps.num;
  return microsToFrames(durationUs + tenthOfFrame, fps, "floor");
}

export function toAsset(r: AssetRow, projectFps: Rational, checkFile = true): Asset {
  return {
    id: r.id,
    projectId: r.project_id,
    kind: r.kind,
    filename: r.filename,
    sourcePath: r.source_path,
    sizeBytes: r.size_bytes,
    durationUs: r.duration_us,
    durationFrames: r.duration_us === null ? null : mediaFrames(r.duration_us, projectFps),
    width: r.width,
    height: r.height,
    fps: r.fps_num && r.fps_den ? { num: r.fps_num, den: r.fps_den } : null,
    vfr: r.vfr === 1,
    hasVideo: r.has_video === 1,
    hasAudio: r.has_audio === 1,
    hasAlpha: r.has_alpha === 1,
    videoCodec: r.video_codec,
    audioCodec: r.audio_codec,
    sampleRate: r.sample_rate,
    channels: r.channels,
    rotation: r.rotation,
    status: checkFile ? fileStatus(r) : "online",
    createdAt: r.created_at,
  };
}

/** Source media references. The engine never writes to the referenced files. */
export class AssetStore {
  readonly #db: Database;
  readonly #now: () => string;

  constructor(db: Database, opts: { now?: () => string } = {}) {
    this.#db = db;
    this.#now = opts.now ?? (() => new Date().toISOString());
  }

  #fps(projectId: string): Rational {
    const row = this.#db.prepare("SELECT fps_num, fps_den FROM projects WHERE id = ?").get(projectId) as
      | { fps_num: number; fps_den: number }
      | undefined;
    if (!row) throw new ReelForgeError("NOT_FOUND", `project ${projectId} not found`, { projectId });
    return { num: row.fps_num, den: row.fps_den };
  }

  list(projectId: string): Asset[] {
    const pid = parse(ProjectIdSchema, projectId);
    const fps = this.#fps(pid);
    const rows = this.#db
      .prepare("SELECT * FROM assets WHERE project_id = ? ORDER BY created_at, filename")
      .all(pid) as unknown as AssetRow[];
    return rows.map((r) => toAsset(r, fps));
  }

  get(projectId: string, assetId: string): Asset {
    const pid = parse(ProjectIdSchema, projectId);
    const aid = parse(ProjectIdSchema, assetId);
    const fps = this.#fps(pid);
    const row = this.#db.prepare("SELECT * FROM assets WHERE id = ? AND project_id = ?").get(aid, pid) as unknown as
      | AssetRow
      | undefined;
    if (!row) throw new ReelForgeError("NOT_FOUND", `asset ${aid} not found in project ${pid}`, { assetId: aid });
    return toAsset(row, fps);
  }

  /** Register an already-probed file. Importing the same path twice returns the existing asset. */
  add(projectId: string, file: AssetFile, probe: AssetProbe, actor: Actor): { asset: Asset; created: boolean } {
    const pid = parse(ProjectIdSchema, projectId);
    return transaction(this.#db, () => {
      const existing = this.#db
        .prepare("SELECT id FROM assets WHERE project_id = ? AND source_path = ?")
        .get(pid, file.path) as { id: string } | undefined;
      if (existing) return { asset: this.get(pid, existing.id), created: false };

      const id = randomUUID();
      const now = this.#now();
      commitRevision(this.#db, {
        projectId: pid,
        kind: "asset.import",
        payload: { assetId: id, filename: basename(file.path), kind: probe.kind },
        actor,
        now,
      });
      this.#db
        .prepare(
          `INSERT INTO assets (id, project_id, kind, source_path, filename, size_bytes, mtime_ms, duration_us, width, height,
             fps_num, fps_den, vfr, has_video, has_audio, has_alpha, video_codec, audio_codec, sample_rate, channels, rotation, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id, pid, probe.kind, file.path, basename(file.path), file.sizeBytes, Math.floor(file.mtimeMs),
          probe.durationUs, probe.width, probe.height, probe.fps?.num ?? null, probe.fps?.den ?? null,
          probe.vfr ? 1 : 0, probe.hasVideo ? 1 : 0, probe.hasAudio ? 1 : 0, probe.hasAlpha ? 1 : 0, probe.videoCodec, probe.audioCodec,
          probe.sampleRate, probe.channels, probe.rotation, now,
        );
      return { asset: this.get(pid, id), created: true };
    });
  }

  /**
   * Point an asset at a new file (FR-007). The replacement must be the same
   * media: same kind and streams, and a duration within one project frame, so
   * clips that reference it keep their meaning.
   */
  relink(projectId: string, assetId: string, file: AssetFile, probe: AssetProbe, actor: Actor): Asset {
    const current = this.get(projectId, assetId);
    const fps = this.#fps(current.projectId);
    const mismatches: string[] = [];
    if (probe.kind !== current.kind) mismatches.push(`kind ${probe.kind} ≠ ${current.kind}`);
    if (probe.hasVideo !== current.hasVideo) mismatches.push("video stream differs");
    if (probe.hasAudio !== current.hasAudio) mismatches.push("audio stream differs");
    if (current.hasVideo && (probe.width !== current.width || probe.height !== current.height)) {
      mismatches.push(`frame size ${probe.width}×${probe.height} ≠ ${current.width}×${current.height}`);
    }
    if (current.fps && probe.fps && current.fps.num * probe.fps.den !== probe.fps.num * current.fps.den) {
      mismatches.push(`frame rate ${probe.fps.num}/${probe.fps.den} ≠ ${current.fps.num}/${current.fps.den}`);
    }
    if (current.durationFrames !== null && probe.durationUs !== null) {
      const frames = mediaFrames(probe.durationUs, fps);
      if (Math.abs(frames - current.durationFrames) > 1) mismatches.push(`duration ${frames} ≠ ${current.durationFrames} frames`);
    }
    if (mismatches.length) {
      throw new ReelForgeError("VALIDATION_ERROR", `replacement file does not match the original media: ${mismatches.join(", ")}`, {
        assetId,
        mismatches,
      });
    }
    return transaction(this.#db, () => {
      const clash = this.#db
        .prepare("SELECT id FROM assets WHERE project_id = ? AND source_path = ? AND id <> ?")
        .get(current.projectId, file.path, current.id) as { id: string } | undefined;
      if (clash) {
        throw new ReelForgeError("VALIDATION_ERROR", "that file is already imported as another asset", { assetId, otherAssetId: clash.id });
      }
      commitRevision(this.#db, {
        projectId: current.projectId,
        kind: "asset.relink",
        payload: { assetId, from: current.sourcePath, to: file.path },
        actor,
        now: this.#now(),
      });
      this.#db
        // Alpha may differ (a flattened export of the same graphic): it changes how we preview, not what clips mean.
        .prepare("UPDATE assets SET source_path = ?, filename = ?, size_bytes = ?, mtime_ms = ?, has_alpha = ? WHERE id = ?")
        .run(file.path, basename(file.path), file.sizeBytes, Math.floor(file.mtimeMs), probe.hasAlpha ? 1 : 0, current.id);
      return this.get(current.projectId, current.id);
    });
  }
}
