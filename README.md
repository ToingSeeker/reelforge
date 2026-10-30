<p align="center"><img src="brand/icon.svg" width="88" alt="" /></p>

<h1 align="center">ReelForge</h1>
<p align="center"><strong>The open-source, AI-native video editing engine.</strong><br/>Describe it. Edit it. Ship it.</p>

---

> **Status: pre-alpha — milestone M0 (Foundation).** Projects, the shared
> engine, the CLI, the local REST API and the desktop shell work. Media import,
> the timeline editor, rendering and the AI Director are not built yet. See
> [docs/milestones.md](docs/milestones.md).

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

Requirements: macOS on Apple Silicon, Node ≥ 24, pnpm 10, and Rust stable (for the desktop shell). FFmpeg is needed from M1.

```sh
pnpm install
pnpm check                 # typecheck + tests

# CLI: every command prints one JSON document
pnpm cli project create --name "Cafe Brand Story"          # 1080×1920 @ 30 fps by default
pnpm cli project create --name "YouTube cut" --width 1920 --height 1080 --fps 29.97
pnpm cli project list
pnpm cli project rename <id> --name "Final" --base-revision 1
pnpm cli project history <id>

# Desktop studio (starts the engine as a sidecar)
pnpm desktop
```

Rename a project from the CLI while the desktop app is open and the window updates within about two seconds. Both read the same workspace.

Data lives in `~/Library/Application Support/ReelForge/reelforge.db`. Set `REELFORGE_HOME` (or pass `--home`) to use another workspace.

## Repository layout

```
packages/core     editing core: schemas, rational timebase, SQLite store, revisions
packages/server   local REST API (loopback only, bearer token, Host/Origin checks)
packages/cli      `reelforge` JSON CLI, including `reelforge serve`
apps/desktop      Tauri 2 + React studio; the Rust shell runs the engine as a sidecar
docs/             PRD, architecture, milestones, design reference
```

Architecture notes: [docs/architecture.md](docs/architecture.md).

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) and our
[Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE). Third-party components (FFmpeg, models, fonts, LUTs) keep their own licenses and are audited before distribution.
