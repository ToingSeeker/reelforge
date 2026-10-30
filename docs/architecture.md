# Architecture (as built, M0)

```
 ┌──────────────┐   invoke("api_info")   ┌──────────────────────┐
 │ React UI     │ ─────────────────────▶ │ Tauri shell (Rust)   │
 │ (webview)    │                        │ spawns + supervises  │
 └──────┬───────┘                        └──────────┬───────────┘
        │ fetch + Bearer token                      │ node reelforge serve
        ▼                                           ▼
 ┌──────────────────────────────────────────────────────────────┐
 │ @reelforge/server   REST /v1 · 127.0.0.1 only · token · Host/Origin checks │
 ├──────────────────────────────────────────────────────────────┤
 │ @reelforge/media    ffprobe/ffmpeg via spawn (no shell) · import · thumbs  │
 ├──────────────────────────────────────────────────────────────┤
 │ @reelforge/core     schemas (zod) · rational timebase · stores              │
 │                     pure timeline reducer · revisions + undo diffs          │
 ├──────────────────────────────────────────────────────────────┤
 │ SQLite (node:sqlite, WAL)   $REELFORGE_HOME/reelforge.db                    │
 └──────────────────────────────────────────────────────────────┘
        ▲
        │ same core, same file
 ┌──────┴───────┐        (M5) ┌──────────────┐
 │ reelforge CLI│             │ MCP server   │
 └──────────────┘             └──────────────┘
```

## Decisions

| Decision | Why |
|---|---|
| **TypeScript core, Rust only for the shell** | One language for the zod schemas that AI proposals, REST, CLI and MCP all validate against. The official MCP SDK is TypeScript. |
| **Engine runs as a sidecar process** | The PRD requires media failures not to take down the UI. The webview never touches SQLite; it uses the same REST API as any client. |
| **`node:sqlite`, not a native addon** | Zero native build. Bundling it means shipping a Node runtime, which M6 packaging handles anyway. |
| **One workspace database** | Simple transactional `projects.list`. Portable per-project packages are a P1 feature. |
| **Optimistic concurrency via `revision`** | Desktop, CLI and MCP write concurrently. A stale `baseRevision` returns `REVISION_CONFLICT` (HTTP 409, CLI exit 4) and never merges silently. |
| **Integer frames on rational fps** | `30000/1001` is exact. Rescaling uses BigInt, so long NTSC timelines don't drift. |
| **No build step for the engine** | Node ≥ 24 strips types natively; `tsc` is used only to typecheck. |

## How an edit happens

1. A client (desktop, CLI, REST, later MCP and the AI Director) sends `{baseRevision, operations[]}`.
2. `TimelineStore.apply` opens `BEGIN IMMEDIATE`, loads tracks/clips/assets into memory and checks the revision.
3. `applyOperations` (pure, in `timeline-ops.ts`) applies each op and re-checks every invariant: overlaps, source
   bounds, track compatibility, locks. Any failure throws, naming the op index, and nothing is written.
4. The before/after **row diff** is written together with the revision bump and an `edit_operations` row, in one commit.
5. Undo writes the stored `before` side, redo the `after` side. Both are new revisions, so history is linear and auditable.
   A new edit after an undo discards the redo stack.

Batches are the unit AI proposals will use in M4: one proposal is one atomic, undoable revision.

## Media

- Source files are referenced by canonical absolute path. They are opened read-only by FFmpeg and never written.
- Import validates each path (absolute, regular file, allowlisted extension, symlinks resolved) **before** FFmpeg runs,
  and FFmpeg gets `file:<path>` in an argument vector, so names like `concat:…` or `$(…)` are inert.
- Durations are stored in microseconds and converted to project frames on read (`floor`), so a clip can never reference
  a frame past the end of its source.
- Thumbnails and waveforms are created on first request in `$REELFORGE_HOME/cache/thumbs`, at most two FFmpegs at a time,
  written to a temp file and renamed atomically.

## REST API (v1)

| Method | Path | |
|---|---|---|
| GET/POST | `/v1/projects` | list / create |
| GET/PATCH | `/v1/projects/:id` | get / rename (`baseRevision`) |
| GET | `/v1/projects/:id/history` | edit_operations |
| GET | `/v1/projects/:id/timeline` | tracks, clips, assets, `history.canUndo/canRedo` |
| POST | `/v1/projects/:id/operations` | `{baseRevision, operations}` |
| POST | `/v1/projects/:id/undo`, `/redo` | `{baseRevision}` |
| GET/POST | `/v1/projects/:id/assets` | list / import `{paths}` |
| POST | `/v1/projects/:id/assets/:assetId/relink` | `{path}` |
| GET | `/v1/projects/:id/assets/:assetId/thumbnail` | JPEG (picture) or PNG waveform (audio) |

## Sidecar lifecycle

1. The Rust shell generates a 256-bit token and spawns `node packages/cli/bin/reelforge.js serve`, passing the token in `REELFORGE_API_TOKEN` and allowing only the webview origins.
2. The engine binds an ephemeral loopback port and prints `{"event":"ready","url":…}`.
3. The UI calls `api_info`, which blocks until the engine is ready (or failed), then talks REST.
4. On app exit the shell kills the engine. If the shell crashes, the engine's stdin closes and it exits on its own.

In development `REELFORGE_NODE` / `REELFORGE_CLI` override the runtime and the script path. A packaged app bundles both (M6).
Set `REELFORGE_DEBUG=1` to log engine requests (method, path, status, origin, never headers or bodies).

## Error contract

| Code | HTTP | CLI exit |
|---|---|---|
| `VALIDATION_ERROR` | 400 | 2 |
| `UNAUTHORIZED` | 401/403 | 5 |
| `NOT_FOUND` | 404 | 3 |
| `UNAVAILABLE` (FFmpeg missing) | 503 | 6 |
| `REVISION_CONFLICT` | 409 | 4 |
| `INTERNAL` | 500 | 1 |
