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

## M2.1 — Look, sound and live preview ✅

Closes the gaps left by M2.

- [x] **Clip properties** (`clip.update`, undoable): fit cover/contain, scale + animated zoom, position, rotation,
      opacity, crop, fade in/out, dissolve/crossfade in, audio gain. Stored sparse, validated by `ClipPropsSchema`;
      split hands fade-in to the left half and fade-out to the right; trims shrink fades instead of failing
- [x] **Dissolves with real handles**: the outgoing clip plays past its out point and the incoming one starts before
      its in point; the plan shrinks a dissolve to the frames the media actually has, and the Inspector says so
- [x] **Shared maths** in `render-plan.ts` (`pictureAlpha`, `audioGain`, `placement`, `activeLayers`) used by the FFmpeg
      compiler and the live preview; FFmpeg ramps are frame-based (`fade s/n`) and sample-based (`afade ss/ns`)
- [x] **Live preview**: canvas compositor over proxies + WebAudio clock, reacts to every edit and to Inspector drags
      before they are committed. "Rendered" mode keeps the exact FFmpeg output. Measured parity on a solid-colour
      project (fade, dissolve, 50 % opacity, scale, offset, 30° rotation): within 3/255 of the full-size export
- [x] **Colour pipeline**: composite in RGB from each source's own matrix, encode BT.709 limited range and tag it
      (exports and proxies). Before, untagged BT.601 output shifted colours in browsers and players
- [x] **Streaming**: proxies, audio, thumbnails and render outputs are served with `Range`; media elements use
      `?token=` (accepted on media GET routes only). No more whole-file blobs
- [x] **Native save dialog verified**: `scripts/e2e/native-export.sh` drives the real app through Accessibility
      (Export → NSSavePanel → Save) and checks the MP4. macOS only, needs Accessibility permission; not in CI
- [x] Inspector panel (right panel tab), fade/dissolve markers on clips, `clip set` / `--props` in the CLI
- [x] 77 tests: pixel-level render checks for contain/scale/position/rotation, opacity/fade/dissolve blends, audio gain
      and fades, BT.709 tags; unit tests for handles, ramps and placement

Known gaps carried forward:
- RGB compositing made the 30 s 1080×1920 export ~2× slower (≈10 s on this Mac); worth optimising later.
- The live preview has no limiter (the export applies a -1 dBFS limiter), so very hot mixes can sound louder live.
- Colour grading (brightness/contrast/saturation/temperature/LUT) is still to do (PRD §12).

## M3 — Media Intelligence ✅ (exit criterion met)

**Exit criterion:** analysis produces structured data the AI Planner can consume. Verified: `GET /v1/projects/:id/context`
(and `reelforge project context`) returns `reelforge.project-context/1` with per-asset scenes, tempo + beat times and
timed transcripts, the timeline (clips, captions) in frames and seconds, and the list of accepted operation types.

- [x] **Scene detection**: FFmpeg `scdet` on the proxy; cuts in source time with scores
- [x] **Beat detection** with no dependencies: spectral-flux onsets, tempo by autocorrelation with a 120 BPM prior,
      DP beat tracking; a confidence score so "no clear beat" is honest (120/90 BPM metronomes within 35 ms)
- [x] **Local transcription**: whisper.cpp large-v3-turbo on Metal + Silero VAD, word timings from tokens; audio never
      leaves the machine. Without VAD whisper wrote "*music*" / "Thank you." for music; with it, nothing
- [x] Analyses are jobs in SQLite (queued/running/completed/failed, progress, stale when the file changes,
      recovery after a crash, killed cleanly when the engine stops)
- [x] **Captions**: generated from voice tracks (words mapped through each clip's trim and position, grouped at
      pauses/punctuation/limits), one undoable `captions.replace`; editable text and timing; three presets; style kept
      on the track apart from the text; SRT export
- [x] **Burned-in captions without libass** (Homebrew FFmpeg has none): shared layout in core, our own anti-aliased
      rasteriser from bundled OFL fonts (Anton, Poppins), frame-exact PNG sequence overlay; word highlight switches on
      the exact frame. The live preview draws the same layout with the same fonts (visually identical in tests)
- [x] Desktop: analysis status + Analyse on media cards, Captions panel (generate, style, editable list, SRT),
      Beats & analysis panel, beat/scene markers on clips, snap to beats and scene cuts, caption blocks you can move
- [x] CLI: `media analyze|analysis`, `captions generate|srt`, `project context`; `scripts/download-models.sh`
- [x] 92 tests, incl. real whisper runs (skipped with a reason when the models aren't installed, e.g. CI)

Known gaps carried forward:
- Translation, advanced motion captions and auto-cut-to-beat edits are P1 (the planner gets beats/scenes to propose them).
- Voice ducking and audio loudness analysis are not built yet.
- No Indonesian system voice on this Mac, so the automated ASR test speaks English; Indonesian works the same way in whisper.

## M4 — AI Director ✅ (exit criterion met)

**Exit criterion:** AI can propose, apply and undo changes on the timeline. Verified in the desktop UI with a local
model (qwen2.5:14b via Ollama): instruction in Indonesian → proposal with a before/after diff → Preview plan (live
preview shows the result, revision unchanged) → Apply (one revision, approval recorded) → ⌘Z reverts it.

- [x] `@reelforge/ai`: provider adapters for **Claude** (official SDK, `claude-opus-5-5`, structured output with the
      proposal schema, adaptive thinking at `high` effort, server-side `fallbacks: "default"`) and **local Ollama**
      (`/api/chat` with the schema as `format`); typed error mapping (missing/rejected key, rate limit, offline, refusal)
- [x] Structured proposals: summary, operations with a "why" each, warnings, estimated duration, the base revision,
      approval requirement; placeholders (`new-1`) for clips a plan creates (PRD §9)
- [x] Validation (FR-021): schema, then a dry run against the real timeline; one repair round with the engine's errors;
      invalid twice → nothing stored, timeline untouched. Engine warnings for what the model can't see (dissolves
      without handles), and a flag when a plan touches clips outside the selection (Workflow B)
- [x] Approval only by a person: desktop Apply (`desktop:apply`) or `ai apply --yes` (`cli:--yes`); the model's text
      can't approve (tested with a reply claiming `"approved": true`). Applied proposals are one undoable revision
      linked by `proposalId` (FR-023/024); stale proposals refused (FR-016)
- [x] Consent per project for external providers; the dialog shows the exact JSON (no media, no local paths)
- [x] Keys in the macOS Keychain via the desktop shell (`keyring`), delivered to the engine over stdin, never returned or
      logged (FR-025). Verified end to end in the native app through Accessibility
- [x] Desktop: model picker, conversation of proposal cards with a diff viewer, Preview plan, Apply/Regenerate/Reject,
      cancel a running request, Settings for keys and consent. CLI: `ai providers|propose|proposals|show|apply|reject|consent`
- [x] 104 tests (fake providers for determinism, a fake Ollama HTTP server for the full REST/CLI path)

Known gaps carried forward:
- Claude was not exercised against the live API here (no key on this Mac); the adapter is covered by type checks,
  error-path tests and the shared planner tests. Add a key in Settings to use it.
- Local models are slow on this Mac (qwen2.5:14b ≈ 4 min, qwen3.5:27b ≈ 2.7 min for the demo project).
- Conversational revisions ("make it faster") and multi-turn memory are P1; each instruction is a fresh proposal.

## M5–M6

MCP & Automation → Alpha Release. See the PRD.
