# Changelog

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
