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
- Every FFmpeg/ffprobe read forces the demuxer from the extension (`mov`, `jpeg_pipe`, `png_pipe`, `wav`, `mp3`) with
  `-protocol_whitelist file`, and the probed `format_name` must match. Content sniffing would otherwise open a
  "clip.mp4" that is really an ffconcat list or HLS playlist and follow it to other files or URLs.
- Durations are stored in microseconds and converted to project frames on read (`floor`), so a clip can never reference
  a frame past the end of its source.
- Thumbnails and waveforms are created on first request in `$REELFORGE_HOME/cache/thumbs`, at most two FFmpegs at a time,
  written to a temp file and renamed atomically.

## Rendering

```
Timeline ──buildRenderPlan──▶ RenderPlan (frames, layers bottom→top, audio segments, source paths)
                                 │                       │
                       previewSettings (≤960px,   exportSettings (project size,
                        proxies, veryfast)          originals, crf 18 medium)
                                 └──────── compileRender ────────┘
                                          one FFmpeg filter_complex
```

- The plan is stored in the job row when the job is created, so a render is reproducible even if editing continues.
- Video offsets are integers in a 1/fps timebase (`settb` + `setpts=…+frames`), audio offsets are sample counts
  (`adelay=…S`). Seconds would be rounded by FFmpeg and land cuts a frame early.
- Jobs live in SQLite; the runner (concurrency 1) re-reads the state on every progress tick, so a cancel from any
  process stops FFmpeg. On start, jobs whose runner PID is gone are failed as `INTERRUPTED`.
- Output: `.<name>.partial-<job>.mp4` in the target folder → ffprobe verification → `link()` to the final name (fails
  rather than overwrites) → unlink the temp file.

## Live preview

`apps/desktop/src/compositor.ts` draws the same `RenderPlan` on a canvas. Each visible clip gets a muted `<video>`
on its proxy (warmed up ~1.5 s before it starts, released when far away); stills use ≤1280 px JPEG proxies. Sound is
decoded into WebAudio buffers and scheduled with gain envelopes from `audioGain()`; the AudioContext clock drives the
picture, and videos are re-seeked when they drift more than 3 frames. Scrubbing seeks to the middle of the frame.

## Colour

Layers are composited in RGB after each source is converted with its own matrix (FFmpeg's scale reads the frame tags),
then encoded as BT.709 limited range with all four colour tags set on the frames (`setparams`), because current FFmpeg
lets frame properties override encoder flags. Proxies get the same conversion so the browser decodes them to the same
colours the export produces.

## Media intelligence

| Analysis | Engine | Result (stored per asset) |
|---|---|---|
| `scenes` | FFmpeg `scdet` on the proxy | cut times (µs) + scores |
| `beats` | `media/src/analysis/beats.ts` (FFT, onsets, tempo, DP tracking) | BPM, confidence, beat times |
| `transcript` | `whisper-cli` large-v3-turbo + Silero VAD | language, segments, words with times and confidence |

Analyses run in an `AnalysisRunner` (one at a time; speech uses the GPU) with their state in the `analyses` table,
so the desktop, CLI and MCP all see progress. Models live in the app-data `models/` folder (shared by every workspace;
`REELFORGE_MODELS` overrides), fetched by `scripts/download-models.sh`.

`buildProjectContext` (core) is the planner's view of a project: settings, assets with analysis summaries, timeline
and captions in frames and seconds, and the accepted operation types.

## Captions

Captions are rows on a caption track (`captions` table) with word timings relative to the caption start; the look is
the track's `captionStyle`. `layoutCaption` (core) places every word; the export rasterises glyph outlines from the
bundled OFL fonts (`assets/fonts`) into one RGBA image per visual state (each word start), writes each state once as
PNG and hard-links it for every frame, then FFmpeg overlays that image sequence frame-exactly. We do this ourselves
because common FFmpeg builds (Homebrew's included) ship without libass/drawtext. The live preview draws the same
layout with the same fonts on its canvas.

## AI Director

```
instruction + selection ──▶ propose() ── buildProjectContext ──▶ provider (Claude | Ollama)
                                                    ◀── JSON (MODEL_OUTPUT_SCHEMA)
          parse → TimelineOpSchema → dry run (TimelineStore.preview) ──✗──▶ one repair round
                                              │ ✓
                         ai_proposals (pending, diff, engine warnings)
                                              │  a person presses Apply / types --yes
                         ProposalStore.apply ── one undoable revision (payload.proposalId)
```

- Providers live in `@reelforge/ai`. Claude uses the official SDK (structured output with the same schema,
  adaptive thinking at `high` effort, server-side `fallbacks: "default"`); Ollama uses its local `/api/chat` with
  the schema as `format`. Both get the same system prompt and project context.
- The model can only return timeline operations: there is no shell, no file access, no asset deletion in the
  schema. Placeholder ids (`new-1`) let a plan add a clip and refer to it later.
- **Approval** is never inferred from model output. It happens only through `POST /v1/proposals/:id/apply` (desktop
  Apply button, recorded as `desktop:apply`) or `reelforge ai apply --yes` (`cli:--yes`). If the timeline changed
  since the proposal, it is marked `stale` instead of being merged over newer edits.
- **Consent** (PRD §19): external providers need per-project consent before any context is sent; the dialog shows
  the exact JSON. Media files are never sent. Local providers need none.
- **Keys** (FR-025): stored in the macOS Keychain by the desktop shell (`keyring` crate, Security framework), passed
  to the engine as a JSON line on its stdin, held in memory only, never returned by any endpoint. The CLI uses
  `ANTHROPIC_API_KEY` or an `ant auth login` profile.
- **Engine warnings** add what the model can't see, e.g. a dissolve that won't play because the clips have no
  spare frames around the cut.

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
| POST | `/v1/projects/:id/render-jobs` | export `{outputPath}` → 202 job |
| POST | `/v1/projects/:id/preview-jobs` | preview of the current revision (reused if one exists) |
| GET | `/v1/projects/:id/jobs?kind=` · `/artifacts` | job list · finished exports |
| GET | `/v1/jobs/:id` · POST `/cancel` · `/retry` | job status and control |
| GET | `/v1/jobs/:id/output` | rendered MP4, supports `Range` |
| POST/GET | `/v1/projects/:id/assets/:assetId/analyze` · `/analysis` | queue analyses · read them |
| GET | `/v1/projects/:id/analyses` | every analysis in the project, by asset |
| POST | `/v1/projects/:id/captions/generate` | 202 `transcribing` (missing transcripts queued) or 200 `applied` |
| GET · POST | `/v1/projects/:id/captions.srt` · `/captions/export-srt` | SubRip text · write it to a chosen path |
| GET | `/v1/projects/:id/context` | structured project context for planners |
| GET | `/v1/fonts/:file` | bundled caption fonts (media route) |
| GET | `/v1/ai/providers` | providers, models, where each key comes from (never the key) |
| GET · POST | `/v1/projects/:id/ai-consent` | read / grant or revoke `{granted}` |
| POST · GET | `/v1/projects/:id/proposals` | ask for a proposal `{instruction, provider, model, selection}` · list |
| GET · POST | `/v1/proposals/:id` · `/apply` · `/reject` | read · approve and apply · reject |
| GET | `/v1/projects/:id/assets/:assetId/media` | what the live preview plays: video proxy, still proxy or original audio (`Range`) |

Media GET routes (`media`, `thumbnail`, job `output`) also accept `?token=` because media elements cannot send headers.
No other route does, and the access log never records query strings.

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
| `UNAVAILABLE` (FFmpeg / model / key missing) | 503 | 6 |
| `CONSENT_REQUIRED` | 403 | 7 |
| `REVISION_CONFLICT` | 409 | 4 |
| `INTERNAL` | 500 | 1 |
