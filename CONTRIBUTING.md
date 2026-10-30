# Contributing to ReelForge

Thanks for helping build ReelForge.

## Ground rules

1. **One core.** Every feature goes through `packages/core`. The desktop UI, CLI, REST API and MCP server never write project state on their own.
2. **Every mutation is a revisioned operation.** It must validate its input, check `baseRevision`, bump the revision and append an `edit_operations` row in one transaction. A rejected change must leave state untouched.
3. **Frames, not seconds.** Timeline positions are integers in the project timebase. Use `packages/core/src/timebase.ts` for conversions.
4. **Originals are read-only.** Nothing may write to, move or delete source footage.
5. **Migrations are append-only.** Never edit a migration that has been merged; add a new one.

## Development

```sh
pnpm install
pnpm check          # typecheck every package + run all tests
pnpm desktop        # Tauri dev window (needs Rust)
```

TypeScript runs directly on Node's type stripping, with no build step for the engine. That means
only erasable syntax is allowed (no `enum`, no parameter properties, no namespaces), and relative imports keep their `.ts` extension.

`pnpm typecheck` is the only thing that typechecks. Node and Vite strip types without checking them.

## Pull requests

- Keep PRs focused, one concern each.
- Add or update tests for behaviour changes; bug fixes come with a test that fails without the fix.
- Run `pnpm check` before pushing; CI runs the same plus a macOS desktop build.
- Describe *why* in the PR body, and how you verified UI changes (screenshots for visual changes).

By contributing you agree that your contributions are licensed under Apache-2.0.
