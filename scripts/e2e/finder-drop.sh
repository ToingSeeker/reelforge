#!/usr/bin/env bash
# End-to-end check of dropping files and folders from Finder onto the app window.
#
# scripts/e2e/finder-drag.swift starts a real AppKit file drag (the same NSDraggingSession Finder
# uses) and drops it on the ReelForge window; the engine's access log shows whether the webview
# imported it. macOS only; the terminal needs Accessibility permission. Not run in CI.
#
# REELFORGE_APP=/path/ReelForge.app tests a release build (launchd's minimal PATH); default is the
# debug build, which needs the Vite dev server (started here if it isn't running).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
if [ -n "${REELFORGE_APP:-}" ]; then
  APP="$REELFORGE_APP/Contents/MacOS/reelforge-desktop"
else
  APP="$ROOT/apps/desktop/src-tauri/target/debug/reelforge-desktop"
fi
[ -x "$APP" ] || { echo "build the desktop app first: (cd apps/desktop/src-tauri && cargo build)"; exit 1; }

WORK="$(mktemp -d)"
cleanup() {
  [ -n "${APP_PID:-}" ] && kill "$APP_PID" 2>/dev/null || true
  if [ -n "${VITE_STARTED:-}" ]; then lsof -ti tcp:5173 -sTCP:LISTEN | xargs kill 2>/dev/null || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

swiftc -O "$ROOT/scripts/e2e/finder-drag.swift" -o "$WORK/drag" 2>/dev/null
rf() { REELFORGE_HOME="$WORK/home" node "$ROOT/packages/cli/bin/reelforge.js" "$@"; }
ffmpeg -hide_banner -loglevel error -f lavfi -i color=c=red:s=540x960:r=30:d=2 -c:v libx264 -pix_fmt yuv420p "$WORK/clip.mp4"
mkdir -p "$WORK/folder/sub"
cp "$WORK/clip.mp4" "$WORK/folder/a.mp4"
cp "$WORK/clip.mp4" "$WORK/folder/b.mp4"
echo x > "$WORK/folder/notes.txt"

if [ -z "${REELFORGE_APP:-}" ] && ! curl -sf -o /dev/null http://localhost:5173; then
  (cd "$ROOT/apps/desktop" && npx vite >/dev/null 2>&1) &
  disown $!
  VITE_STARTED=1
  for _ in $(seq 1 50); do curl -sf -o /dev/null http://localhost:5173 && break; sleep 0.2; done
fi

# drop <path> <create-project?> → prints the number of assets in the newest project afterwards
drop() {
  rm -rf "$WORK/home"
  mkdir -p "$WORK/home"
  [ "$2" = yes ] && rf project create --name "Drop target" >/dev/null
  if [ -n "${REELFORGE_APP:-}" ]; then
    env -i HOME="$HOME" USER="$USER" PATH=/usr/bin:/bin:/usr/sbin:/sbin REELFORGE_HOME="$WORK/home" "$APP" >/dev/null 2>&1 &
  else
    REELFORGE_HOME="$WORK/home" "$APP" >/dev/null 2>&1 &
  fi
  APP_PID=$!
  sleep 12 # first launch of a fresh build is slow (signature check)
  "$WORK/drag" "$1" reelforge >&2
  sleep 4
  kill "$APP_PID"; APP_PID=
  sleep 1
  local pid
  pid=$(rf project list | node -pe 'JSON.parse(require("fs").readFileSync(0)).projects[0]?.id ?? ""')
  [ -n "$pid" ] && rf media list "$pid" | node -pe 'JSON.parse(require("fs").readFileSync(0)).assets.length' || echo 0
}

fail=0
check() { if [ "$2" = "$3" ]; then echo "PASS: $1 ($2 assets)"; else echo "FAIL: $1: expected $3 assets, got $2"; fail=1; fi; }
check "file onto an open project" "$(drop "$WORK/clip.mp4" yes)" 1
check "file with no project open (creates one)" "$(drop "$WORK/clip.mp4" no)" 1
check "folder (its media files, not notes.txt or sub/)" "$(drop "$WORK/folder" yes)" 2
exit $fail
