<p align="center"><img src="brand/icon.svg" width="88" alt="" /></p>

<h1 align="center">ReelForge</h1>
<p align="center"><strong>The open-source, AI-native video editing engine.</strong><br/>Describe it. Edit it. Ship it.</p>

---

> **Status: 0.1.0-alpha.1.** Multi-track editing with undo/redo, a
> live preview, frame-exact MP4 export, local scene/beat/speech analysis,
> animated captions, an **AI Director** (Claude or local Ollama), a local **MCP
> server** for external AI clients, and **workflow recipes**. See [CHANGELOG](CHANGELOG.md). Transcription/captions
> (M3) and the AI Director (M4) are not built yet. See [docs/milestones.md](docs/milestones.md).

ReelForge turns raw footage into editable, reviewable vertical video. You can drive it
from a desktop studio, a built-in AI Director, any MCP client (Claude, ChatGPT, Gemini CLI),
or a JSON CLI. **Every surface goes through one editing core**, one timeline model and one project store,
so an edit made by an AI agent is the same kind of edit you make by hand: validated, revisioned and undoable.

- **Local-first.** Projects live in a SQLite workspace on your machine. No account needed.
- **Non-destructive.** Original footage is only ever read.
- **Editable AI output.** AI produces timeline proposals you approve, never a flattened file.
- **Frame-exact.** Time is integer frames on a rational timebase (30000/1001, not 29.97).

Full specification: [docs/PRD.md](docs/PRD.md) · UI reference: [docs/design/edit-studio-mockup.png](docs/design/edit-studio-mockup.png)

## Quickstart

Requirements: macOS on Apple Silicon, Node ≥ 24, pnpm 10, FFmpeg (`brew install ffmpeg`), and Rust stable (for the desktop shell).
For transcription and captions: `brew install whisper-cpp` and `./scripts/download-models.sh` (≈1.6 GB, verified by SHA-256).

```sh
pnpm install
pnpm check                 # typecheck + tests

# CLI: every command prints one JSON document
pnpm cli project create --name "Cafe Brand Story"          # 1080×1920 @ 30 fps by default
pnpm cli project create --name "YouTube cut" --width 1920 --height 1080 --fps 29.97
pnpm cli project list
pnpm cli project rename <id> --name "Final" --base-revision 1
pnpm cli project history <id>

# Media and timeline (times: frames, 2.5s, 00:00:03:00 or 00:03.10)
pnpm cli media import <project> ~/Footage/*.mp4 ~/Music/track.wav
pnpm cli clip add <project> --track V1 --asset <asset> --start 0 --duration 4s
pnpm cli clip split <project> <clip> --at 2s
pnpm cli clip delete <project> <clip> --ripple
pnpm cli clip set <project> <clip> --props '{"fadeIn":15,"transitionIn":12,"scale":1.1,"scaleEnd":1.3}'
pnpm cli timeline undo <project>
pnpm cli timeline get <project>

# Render (same graph for preview and export; exports never overwrite)
pnpm cli preview <project>
pnpm cli render <project> --out ~/Movies/reel.mp4
pnpm cli jobs list <project>

# Media intelligence and captions (all local)
pnpm cli media analyze <project> <asset> --kinds scenes,beats,transcript
pnpm cli captions generate <project> --source A2 --max-words 3 --language id
pnpm cli captions srt <project> --out captions.srt
pnpm cli project context <project>        # what an AI planner reads

# AI Director: proposals you review and approve (local model, or Claude with consent)
pnpm cli ai propose <project> "Fade in the first clip and cut the B-roll on the beat" --provider ollama
pnpm cli ai show <proposal>
pnpm cli ai apply <proposal> --yes
pnpm cli ai consent <project> --grant     # before using Claude (ANTHROPIC_API_KEY or `ant auth login`)

# Desktop studio (starts the engine as a sidecar)
pnpm desktop
```

Rename a project from the CLI while the desktop app is open and the window updates within about two seconds. Both read the same workspace.

Data lives in `~/Library/Application Support/ReelForge/reelforge.db`. Set `REELFORGE_HOME` (or pass `--home`) to use another workspace.

## Install (alpha, macOS Apple Silicon)

1. Install the media tools: `brew install ffmpeg whisper-cpp`
2. Open `ReelForge_0.1.0-alpha.1_aarch64.dmg` and drag ReelForge to Applications.
3. Alpha builds are **not signed by Apple**, so macOS blocks the first open. Open it once, then go to
   **System Settings → Privacy & Security** and press **Open Anyway** (or run
   `xattr -dr com.apple.quarantine /Applications/ReelForge.app`). Only do this for a DMG you got from this project.
4. For captions/transcripts, download the speech models once: `scripts/download-models.sh` (from this repository).

Building it yourself: see [docs/releasing.md](docs/releasing.md).

## Use it from Claude, ChatGPT or Gemini CLI (MCP)

ReelForge ships a local MCP server over stdio. External AI clients can create projects, import and analyse media,
read the timeline, propose edits and render. **Every timeline change is a proposal you approve**: the client asks you
(MCP elicitation), or you press Apply in ReelForge, or run `reelforge ai apply <id> --yes`.

```sh
# Claude Code, from a source checkout
claude mcp add reelforge -- node /path/to/reelforge/packages/cli/bin/reelforge.js mcp

# Claude Code, using the installed app's own engine (no repository needed)
claude mcp add reelforge -- /Applications/ReelForge.app/Contents/Resources/engine/node /Applications/ReelForge.app/Contents/Resources/engine/reelforge.mjs mcp
```

Claude Desktop and other clients (`mcpServers` config):

```json
{ "mcpServers": { "reelforge": { "command": "node", "args": ["/path/to/reelforge/packages/cli/bin/reelforge.js", "mcp"] } } }
```

Tools: `projects_list|create|get`, `media_import|analyze|get_analysis`, `audio_detect_beats`, `timeline_get`,
`timeline_propose_edit|get_proposal|apply_proposal|undo`, `captions_generate`, `preview_create`, `render_start`,
`jobs_get|cancel`, `outputs_get`, `workflows_run|runs` (PRD §14 names with `_` instead of `.`, as Claude's API requires).

## Workflow recipes

Repeatable JSON recipes (import → analyse → assemble → captions → AI pass → render): see
[examples/workflows](examples/workflows/README.md). `reelforge workflow run recipe.json`.

## Repository layout

```
packages/core     editing core: schemas, rational timebase, timeline reducer, SQLite stores, undo
packages/media    FFprobe/FFmpeg: import, probing, thumbnails and waveforms
packages/server   local REST API (loopback only, bearer token, Host/Origin checks)
packages/ai       AI Director: Claude + Ollama adapters, proposal planner
packages/automation  workflow recipes (JSON) runner
packages/mcp      MCP server (stdio) over the same engine
packages/cli      `reelforge` JSON CLI, including `reelforge serve` and `reelforge mcp`
apps/desktop      Tauri 2 + React studio; the Rust shell runs the engine as a sidecar
docs/             PRD, architecture, milestones, design reference
```

Architecture notes: [docs/architecture.md](docs/architecture.md).

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) and our
[Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE). Third-party components keep their own licenses: FFmpeg, whisper.cpp (MIT) and its models,
the bundled caption fonts Anton and Poppins (SIL Open Font License, texts in `assets/fonts/`), opentype.js (MIT).
