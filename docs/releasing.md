# Releasing ReelForge

## Build

```sh
pnpm install --frozen-lockfile   # exactly the reviewed lockfile; fails instead of re-resolving
pnpm check
pnpm release:mac                 # cargo runs with --locked for the same reason (needs ~/.cargo/bin on PATH)
# → apps/desktop/src-tauri/target/release/bundle/dmg/ReelForge_<version>_aarch64.dmg
```

`tauri build` runs `scripts/release/build-engine.mjs` first, which puts into `src-tauri/engine/` (bundled as
`ReelForge.app/Contents/Resources/engine/`):

| File | What |
|---|---|
| `reelforge.mjs` | the CLI/engine as one esbuild bundle (`serve`, `mcp`, …) |
| `node` | the official Node.js runtime from nodejs.org, pinned version + SHA-256 (not Homebrew's, which links Homebrew libraries) |
| `fonts/` | the OFL caption fonts |
| `THIRD_PARTY_NOTICES.txt` | licences of every shipped JS package, Rust crate, Node and the fonts; the build fails on a licence outside the allowlist |

A release build of the shell runs that engine; a debug build runs the monorepo CLI on your own Node. Apps opened
from Finder get launchd's PATH, so the shell appends `/opt/homebrew/bin` and `/usr/local/bin` for FFmpeg and
whisper.cpp (not bundled; users install them).

`CI=true` (set by `release:mac`) skips the DMG window-layout AppleScript, which times out when Finder automation
isn't allowed.

Verify a build like a user would: `REELFORGE_APP=/path/ReelForge.app scripts/e2e/native-export.sh` launches it with
launchd's minimal PATH and exports through the real save panel.

To bump the Node runtime: change `NODE_VERSION` and the checksum in `build-engine.mjs` from
`https://nodejs.org/dist/v<version>/SHASUMS256.txt`. Check that file's signature first
(`SHASUMS256.txt.sig`/`.asc`, against the Node release keys listed in the nodejs/node README), so the pin doesn't
rest only on the site it was downloaded from.

## Publishing

Publish the DMG's SHA-256 next to it (`shasum -a 256 ReelForge_*.dmg`) in the release notes. Ad-hoc signed builds
have no other integrity root a user can check; Developer ID signing + notarization (below) is the real fix for public
releases.

## Signing and notarization

Nothing secret lives in the repository. Without credentials the app is **ad-hoc signed** (`signingIdentity: "-"`),
which is what alpha builds are: macOS warns on first open.

With a **Developer ID Application** certificate in your Keychain, set environment variables (Tauri reads them and
they override the config):

```sh
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
# notarization: either an Apple ID with an app-specific password…
export APPLE_ID="you@example.com" APPLE_PASSWORD="xxxx-xxxx-xxxx-xxxx" APPLE_TEAM_ID="TEAMID"
# …or an App Store Connect API key (better for CI)
export APPLE_API_ISSUER="…" APPLE_API_KEY="…" APPLE_API_KEY_PATH="/secure/AuthKey_XXXX.p8"
pnpm release:mac
```

An "Apple Development" certificate is not enough: it can't be notarized for distribution outside the App Store.

In CI, keep these as encrypted secrets used only by a tag-triggered release job, never by `pull_request` jobs, and
don't use `pull_request_target`.

## Forks

If you distribute your own build, change `identifier` in `apps/desktop/src-tauri/tauri.conf.json` (and the Keychain
service name in `src-tauri/src/lib.rs`) so it doesn't collide with official ReelForge builds.

## Platforms

Alpha builds are macOS on Apple Silicon (macOS 13+). Intel macOS needs the x64 Node checksum in `build-engine.mjs`
and a `--target x86_64-apple-darwin` build; Windows and Linux are not packaged yet.
