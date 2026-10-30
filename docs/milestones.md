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

## M2 — Preview & Render (next)

Proxy engine, canonical render graph shared by preview and export, playback transport, FFmpeg render jobs
(queued → rendering → muxing → completed, with cancel/retry and atomic output). Exit: a 30-second project renders to MP4 H.264/AAC.

## M3–M6

Media Intelligence → AI Director → MCP & Automation → Alpha Release. See the PRD.
