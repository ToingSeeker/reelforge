import { join } from "node:path";
import { AnalysisStore, AssetStore, isReelForgeError, type Analysis, type Database } from "@reelforge/core";
import { ensureProxy } from "../proxy.ts";
import { BEATS_ENGINE, detectBeats } from "./beats.ts";
import { detectScenes, SCENES_ENGINE } from "./scenes.ts";
import { existsSync } from "node:fs";
import { TRANSCRIPT_ENGINE, transcribe, vadModelPath } from "./transcribe.ts";

/**
 * Runs queued analyses one at a time (speech recognition uses the whole GPU).
 * State lives in SQLite so the desktop, CLI and MCP all see progress.
 */
export class AnalysisRunner {
  readonly #db: Database;
  readonly #store: AnalysisStore;
  readonly #cacheDir: string;
  readonly #queue: string[] = [];
  readonly #waiters = new Map<string, ((a: Analysis) => void)[]>();
  #busy = false;
  #stopped = false;
  #abort: AbortController | null = null;

  constructor(db: Database, opts: { cacheDir: string }) {
    this.#db = db;
    this.#store = new AnalysisStore(db);
    this.#cacheDir = opts.cacheDir;
  }

  start(): void {
    this.#store.recoverInterrupted();
    for (const id of this.#store.queued()) this.enqueue(id);
  }

  enqueue(id: string): void {
    if (!this.#queue.includes(id)) this.#queue.push(id);
    void this.#pump();
  }

  wait(id: string): Promise<Analysis> {
    const a = this.#store.get(id);
    if ((a.state === "completed" || a.state === "failed") && !this.#queue.includes(id)) return Promise.resolve(a);
    return new Promise((r) => this.#waiters.set(id, [...(this.#waiters.get(id) ?? []), r]));
  }

  /** Stop for good: the running analysis is killed and nothing more is written. */
  stop(): void {
    this.#stopped = true;
    this.#abort?.abort();
  }

  async #pump() {
    if (this.#busy) return;
    this.#busy = true;
    try {
      while (!this.#stopped && this.#queue.length) {
        const id = this.#queue.shift()!;
        await this.#run(id);
        if (this.#stopped) break;
        const a = this.#store.get(id);
        for (const w of this.#waiters.get(id) ?? []) w(a);
        this.#waiters.delete(id);
      }
    } finally {
      this.#busy = false;
    }
  }

  async #run(id: string) {
    if (!this.#store.claim(id)) return;
    const a = this.#store.get(id);
    const abort = new AbortController();
    this.#abort = abort;
    try {
      const row = this.#db.prepare("SELECT project_id FROM assets WHERE id = ?").get(a.assetId) as { project_id: string };
      const asset = new AssetStore(this.#db).get(row.project_id, a.assetId);
      if (a.kind === "scenes") {
        const proxy = await ensureProxy(this.#db, this.#cacheDir, asset.id, asset.sourcePath, "video");
        if (this.#stopped) return;
        this.#store.progress(id, 0.3);
        const scenes = await detectScenes(proxy, Number(a.params.threshold ?? 10));
        if (this.#stopped) return;
        this.#store.complete(id, SCENES_ENGINE, scenes);
      } else if (a.kind === "beats") {
        const beats = await detectBeats(asset.sourcePath);
        if (this.#stopped) return;
        this.#store.complete(id, BEATS_ENGINE, beats);
      } else {
        const result = await transcribe(asset.sourcePath, join(this.#cacheDir, "work", id), {
          language: typeof a.params.language === "string" ? a.params.language : "auto",
          onProgress: (p) => !this.#stopped && this.#store.progress(id, 0.05 + 0.9 * p),
          signal: abort.signal,
        });
        if (this.#stopped) return;
        this.#store.complete(id, existsSync(vadModelPath()) ? `${TRANSCRIPT_ENGINE} + silero VAD` : TRANSCRIPT_ENGINE, result);
      }
    } catch (e) {
      // After stop() the database may already be closed; the row is recovered as interrupted next start.
      if (!this.#stopped) this.#store.fail(id, isReelForgeError(e) || e instanceof Error ? e.message : String(e));
    } finally {
      if (this.#abort === abort) this.#abort = null;
    }
  }
}
