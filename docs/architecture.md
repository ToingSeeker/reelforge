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
 │ @reelforge/core     schemas (zod) · rational timebase · ProjectStore       │
 │                     revisions + edit_operations in one transaction         │
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
| `REVISION_CONFLICT` | 409 | 4 |
| `INTERNAL` | 500 | 1 |
