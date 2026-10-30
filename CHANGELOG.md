# Changelog

## Unreleased

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
