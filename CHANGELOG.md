# Changelog

## Unreleased

- **Videos play their own sound**, like in other editors: a clip on V1/V2 is heard without copying it to an audio
  track. Picture tracks get a speaker toggle (the eye still hides only the picture), video clips get a Gain control,
  and the Inspector warns when the same media plays twice (e.g. a copy made earlier on A2)
- AI Director: "make captions" requests transcribe the speech locally and propose word-timed captions

Security fixes from the first full audit (MCP clients are treated as possibly prompt-injected):

- MCP `timeline_undo` now asks the user (elicitation) instead of undoing silently; applying a proposal warns when it
  would make undone edits impossible to redo
- MCP `workflows_run` asks before import steps with glob patterns; globs import only media files and never name the
  other entries they saw
- Workflow render steps create a missing output folder only for recipe files run by a person (CLI, desktop), never
  for a folder an MCP client chose; the export path is checked first
- AI Director shows proposals written by an MCP client as theirs (not as your message), opens the change list, and
  hides Regenerate for them
- The release app runs only its bundled engine: `REELFORGE_NODE`/`REELFORGE_CLI` work in development builds only,
  and `NODE_*` variables (e.g. `NODE_OPTIONS`) are removed before the engine, which receives the API key, starts

- Dropping files from Finder with no project open did nothing; it now creates a project named after what you dropped.
  Dropped folders import the media files inside them (not subfolders); other items are counted as skipped

Hardening from the same audit:

- Release builds: thumbnails and the live preview were blocked by the CSP (`img-src`/`media-src` didn't allow the
  local engine); fixed, and the CSP gained `object-src`/`base-uri`/`form-action`/`frame-ancestors 'none'`
- The engine token goes to the engine over its stdin pipe, never the environment, so FFmpeg/whisper never inherit it
- The Vite dev origin is accepted only by development builds; webview permissions narrowed to event listening and
  open/save dialogs
- Transcription audio is capped (6 h, and by size); beat decoding has a timeout
- Workflow globs stop past 200 media files / 20 000 entries; run records name at most 10 failed files
- Exports: an unguessable, exclusively created partial file; a dangling symlink at the target is refused up front
- FFmpeg: `-enable_drefs 0` for MOV/MP4, single-image output for thumbnails, proxies probed like sources
- MCP: `jobs_cancel` only for jobs the session started (queued ones are dropped when it disconnects); one preview per
  revision; the Apply prompt counts the changes it shows; beats report "in progress" instead of a false failure
- AI: Ollama on another host needs consent like Claude; selection warnings cover tracks, captions and new clips; a
  track rename shows in the diff; the card labels the model's/client's reasons as theirs
- `reelforge serve` waits for running renders before closing the database
- Releases: `pnpm install --frozen-lockfile` and `cargo --locked`; CI actions pinned by commit SHA; SECURITY.md
  describes the actual path and MCP trust model

## 0.1.0-alpha.1 — 2026-10-30

First alpha. macOS on Apple Silicon, **not signed or notarized** (see README → Install).

- Multi-track editor: import, trim, split, move, transitions, gain/fades, transform; undo/redo; live preview
- Frame-exact H.264/AAC MP4 export (BT.709), render queue with cancel/retry
- Local analysis: scenes, beats/tempo, speech transcription (whisper.cpp large-v3-turbo + Silero VAD)
- Animated captions (Bold / Clean / Boxed), SRT export
- AI Director: Claude or a local Ollama model proposes timeline edits; you preview, apply, undo
- Local MCP server (`reelforge mcp`) for Claude, ChatGPT, Gemini CLI and other clients; every timeline change needs
  your approval
- Workflow recipes (JSON) from the CLI, the Automation Lab or MCP
- Self-contained app: bundled Node.js runtime and engine; FFmpeg and whisper.cpp come from Homebrew

Known limitations: no Intel/Windows/Linux builds; transcription models are downloaded with
`scripts/download-models.sh` from the source tree; analysis jobs can't be cancelled; MCP not yet tested with
third-party clients beyond the official SDK client.
