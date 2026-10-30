# Milestones

Source of truth for scope: [PRD §22](PRD.md#22-development-milestones).

## M0 — Foundation ✅ (exit criterion met)

**Exit criterion:** desktop and CLI read the same project state. Verified:
a project renamed from the CLI appears in the desktop window, and a project created in the desktop is listed by the CLI with `actor: "desktop"` in its history.

- [x] pnpm monorepo (`packages/core`, `packages/server`, `packages/cli`, `apps/desktop`)
- [x] Project schema v1 with ID, schema version and revision (FR-001–FR-003)
- [x] SQLite store with append-only migrations, WAL, foreign keys, transactional writes (FR-004, FR-015)
- [x] Stale-revision conflicts that leave state untouched (FR-016, FR-018)
- [x] Rational timebase utilities + tests
- [x] Basic project CRUD: create, list, get, rename, history
- [x] JSON CLI with stable exit codes
- [x] Local REST API (loopback, token, Host/Origin checks)
- [x] Tauri 2 shell with engine sidecar; default-deny capabilities; CSP
- [x] Design tokens + Edit Studio layout from the mockup (static panels for later milestones)
- [x] CI: typecheck + tests (Linux, macOS), desktop UI build + `cargo check` (macOS)

Known gaps carried forward:
- Crash recovery / auto-save is implicit (every edit commits), with no explicit recovery UI yet (FR-005).
- Panels are not yet resizable or persisted (PRD §16).
- The desktop app needs `node` on PATH; bundling the runtime is M6.

## M1 — Editing Core ✅ (exit criterion met)

**Exit criterion:** editing state is stable and persists after restart. Verified:
a timeline edited from the desktop UI and the CLI was snapshotted, the engine was stopped and restarted,
and the timeline (tracks, clips, revision, undo history) came back byte-identical. Undo still worked after the restart.

- [x] `@reelforge/media`: FFprobe metadata, rotation-aware dimensions, VFR flag, MVP extension allowlist (FR-008, FR-009)
- [x] Import with per-file failures and actionable messages; duplicates and symlinks resolve to one asset (FR-013)
- [x] Missing/changed source detection and relink that refuses different media (kind, streams, size, rate, duration) (FR-007)
- [x] Thumbnails and audio waveforms generated on demand into the cache, never beside the source (FR-010, partial)
- [x] Tracks: video, overlay, audio and caption, with mute/hide/lock (undoable)
- [x] Clip operations: add, move (incl. across tracks), trim start/end, split, delete, ripple delete
- [x] Invariants: no overlaps, source bounds, track compatibility, locked tracks; whole batch rejected on any failure (FR-015, FR-018)
- [x] Linear undo/redo from stored row diffs; every step is a new revision (FR-016)
- [x] REST + CLI for all of the above (`media`, `timeline`, `clip` commands; times in frames, seconds or timecode)
- [x] Desktop: media grid, drag to timeline, double-click append, clip drag/trim with snapping, split/delete/ripple,
      playhead and zoom, keyboard shortcuts, poster frame at the playhead, conflict reload
- [x] 54 tests incl. real-FFmpeg fixtures (corrupt files, hostile file names, rotation, symlinks)

Known gaps carried forward:
- Proxies and progressive cache (PRD FR-010) are M2. Thumbnails are generated per request, with a concurrency limit.
- Transitions, gain/fades and clip transforms (PRD §8) are not built yet.
- Not verified through UI automation: the native file dialog and Finder drag-and-drop (no screen access in CI or this environment).
- Panels are still not resizable.

## M2 — Preview & Render ✅ (exit criterion met)

**Exit criterion:** a 30-second project renders to MP4 to spec. Verified by test (`render.test.ts`) and by a desktop export:
H.264 High / yuv420p, 1080×1920, 30/1 fps, exactly `durationFrames` frames, AAC 48 kHz stereo, `+faststart`.

- [x] Canonical render plan in core (`render-plan.ts`): picture from visible video/overlay tracks, sound from unmuted
      audio tracks, offline media refused. Preview and export compile the **same** plan (FR-017)
- [x] FFmpeg compiler: cover-fit scaling, project-rate conform, offsets in exact frames (1/fps timebase) and samples,
      sum mix with a -1 dBFS limiter (clipping protection), `-frames:v` for an exact length
- [x] Render jobs: queued → analyzing → rendering → muxing → completed | failed | cancelled, with progress, cancel
      (also from another process), retry, recovery of jobs whose process died (INTERRUPTED)
- [x] Atomic output: temp file in the target folder, verified with ffprobe (frames, size), hard-linked into place;
      exports never overwrite and never target source media
- [x] Proxy engine (≤960 px, short GOP) for previews; previews ≤960 px tall, one per revision, newest two kept
- [x] REST (`render-jobs`, `preview-jobs`, `jobs`, cancel/retry, output with Range) and CLI (`render`, `preview`, `jobs`)
- [x] Desktop: auto preview after edits with progress badge, play/pause (Space) synced to the playhead, frame-exact
      scrubbing, Export via save dialog with progress/cancel, Review & Export render queue
- [x] Tests: frame-exact cuts on odd frames at 30 and 29.97 fps, overlay timing, audio placement, hidden/muted tracks,
      preview = export colours, cancel leaves no files, offline media, path rules

Known gaps carried forward:
- Transitions, gain/fades, transforms (PRD §8/§12) still to do; clips always cover-fit.
- Preview is a rendered file, not real-time compositing: after an edit there is a short re-render (seconds for 30 s).
- Preview output is fetched whole as a blob (fine for short reels; long timelines should stream via Range with a URL token).
- Not verified by UI automation: the native save dialog (browser dev mode uses a prompt).

## M3–M6

Media Intelligence → AI Director → MCP & Automation → Alpha Release. See the PRD.
