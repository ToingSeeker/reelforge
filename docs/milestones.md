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

## M1 — Editing Core (next)

Import media (FFprobe metadata, asset references, missing-file detection + relink), tracks and clips tables,
trim / split / move / ripple as revisioned operations, undo/redo from `edit_operations`, and timeline UI interactions.

## M2–M6

Preview & Render → Media Intelligence → AI Director → MCP & Automation → Alpha Release. See the PRD.
