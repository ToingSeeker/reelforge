#!/usr/bin/env bash
# End-to-end check of the desktop Export flow through the real macOS save panel.
#
# Drives the running app with System Events (Accessibility): presses Export in
# the webview, fills the native NSSavePanel, presses Save, then verifies the
# rendered MP4. macOS only; the terminal needs Accessibility permission
# (System Settings → Privacy & Security → Accessibility). Not run in CI.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP="$ROOT/apps/desktop/src-tauri/target/debug/reelforge-desktop"
[ -x "$APP" ] || { echo "build the desktop app first: (cd apps/desktop/src-tauri && cargo build)"; exit 1; }

WORK="$(mktemp -d)"
export REELFORGE_HOME="$WORK/home"
OUT_DIR="$WORK/out"
mkdir -p "$OUT_DIR"
cleanup() {
  [ -n "${APP_PID:-}" ] && kill "$APP_PID" 2>/dev/null || true
  # npx forks the real vite process, so stop whatever we started listening on the port.
  if [ -n "${VITE_STARTED:-}" ]; then lsof -ti tcp:5173 -sTCP:LISTEN | xargs kill 2>/dev/null || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

rf() { node "$ROOT/packages/cli/bin/reelforge.js" "$@"; }
json() { node -pe "const v=JSON.parse(require('fs').readFileSync(0)); $1"; }

# A one-clip project, so Export has something to render.
ffmpeg -hide_banner -loglevel error -f lavfi -i color=c=red:s=540x960:r=30:d=2 -c:v libx264 -pix_fmt yuv420p "$WORK/red.mp4"
PROJECT=$(rf project create --name "E2E native export" | json 'v.project.id')
ASSET=$(rf media import "$PROJECT" "$WORK/red.mp4" | json 'v.imported[0].id')
rf clip add "$PROJECT" --track V1 --asset "$ASSET" --start 0 --duration 1s >/dev/null

# The debug build loads the UI from the Vite dev server.
if ! curl -sf -o /dev/null http://localhost:5173; then
  (cd "$ROOT/apps/desktop" && npx vite >/dev/null 2>&1) &
  disown $!
  VITE_STARTED=1
  for _ in $(seq 1 50); do curl -sf -o /dev/null http://localhost:5173 && break; sleep 0.2; done
fi

"$APP" >/dev/null 2>&1 &
APP_PID=$!
disown "$APP_PID"
sleep 6

RESULT=$(osascript "$ROOT/scripts/e2e/native-export.applescript" "$OUT_DIR" "native-export.mp4")
echo "save panel: $RESULT"
[[ "$RESULT" == OK* ]] || exit 1

for _ in $(seq 1 120); do [ -f "$OUT_DIR/native-export.mp4" ] && break; sleep 0.5; done
FRAMES=$(ffprobe -v error -select_streams v:0 -show_entries stream=nb_frames -of csv=p=0 "$OUT_DIR/native-export.mp4" 2>/dev/null || true)
if [ "$FRAMES" = "30" ]; then
  echo "PASS: exported through the native save panel ($FRAMES frames)"
else
  echo "FAIL: expected a 30-frame export, got '${FRAMES:-no file}'"
  exit 1
fi
