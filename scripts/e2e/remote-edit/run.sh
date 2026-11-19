#!/usr/bin/env bash
# End-to-end check of the phone remote's manual Edit workspace.
#
# Starts a scratch engine and a local relay, pairs a phone-sized Chromium (Playwright) with the
# engine, and drives the editor: trim, split, ripple delete, reorder, framing, captions, audio,
# look, conflicts with desktop edits (online and queued offline), connection loss, Done → Review →
# export, and a pinch during trim auto-scroll. Every step is checked on the engine's timeline, not
# just on the screen. Nothing touches your real projects: everything lives in a temp folder.
#
# Needs: node, ffmpeg, python3 with playwright (`pip install playwright && playwright install
# chromium`). Not run in CI.
#
#   scripts/e2e/remote-edit/run.sh            # full scenario + pinch check
#   KEEP=1 scripts/e2e/remote-edit/run.sh     # keep the work folder (screenshots, logs)
#   ENGINE_PORT=4402 RELAY_PORT=8791          # override the ports (both must be free)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
HERE="$ROOT/scripts/e2e/remote-edit"
export RF_E2E_WORK="${RF_E2E_WORK:-$(mktemp -d)}"
export ENGINE_PORT="${ENGINE_PORT:-4402}" RELAY_PORT="${RELAY_PORT:-8791}"
export RF_E2E_TOKEN="e2e-token-$(openssl rand -hex 16)"
export REELFORGE_HOME="$RF_E2E_WORK/home" REELFORGE_EXPORT_DIR="$RF_E2E_WORK/exports"
CLI=(node "$ROOT/packages/cli/bin/reelforge.js")
ENGINE="http://127.0.0.1:$ENGINE_PORT"
AUTH_H="Authorization: Bearer $RF_E2E_TOKEN"

for port in "$ENGINE_PORT" "$RELAY_PORT"; do
  if lsof -ti "tcp:$port" -sTCP:LISTEN >/dev/null; then echo "port $port is in use"; exit 1; fi
done

cleanup() {
  [ -n "${ENGINE_PID:-}" ] && kill "$ENGINE_PID" 2>/dev/null || true
  # The scenario restarts the relay itself, so stop whatever listens on its port.
  lsof -ti "tcp:$RELAY_PORT" -sTCP:LISTEN | xargs kill 2>/dev/null || true
  lsof -ti "tcp:$ENGINE_PORT" -sTCP:LISTEN | xargs kill 2>/dev/null || true
  if [ -n "${KEEP:-}" ]; then echo "work folder kept: $RF_E2E_WORK"; else rm -rf "$RF_E2E_WORK"; fi
}
trap cleanup EXIT
mkdir -p "$REELFORGE_HOME" "$REELFORGE_EXPORT_DIR" "$RF_E2E_WORK/media" "$RF_E2E_WORK/shots"

# ── Media: generated, so the run needs no sample files ─────────────────────
M="$RF_E2E_WORK/media"
ff() { ffmpeg -v error -y "$@"; }
ff -f lavfi -i testsrc2=size=540x960:rate=30:duration=6 -f lavfi -i sine=frequency=440:duration=6 -shortest -c:v libx264 -pix_fmt yuv420p -c:a aac "$M/C001_Espresso.mp4"
ff -f lavfi -i testsrc2=size=1920x1080:rate=30:duration=20 -f lavfi -i sine=frequency=330:duration=20 -shortest -c:v libx264 -pix_fmt yuv420p -c:a aac "$M/wide.mp4"
ff -f lavfi -i testsrc2=size=540x960:rate=30:duration=7 -c:v libx264 -pix_fmt yuv420p "$M/C004_Beans.mp4"
ff -f lavfi -i sine=frequency=220:duration=30 "$M/Cafe_Mood.wav"

# ── Project ─────────────────────────────────────────────────────────────────
PID=$("${CLI[@]}" project create --name "Spider trade" --width 1080 --height 1920 --fps 30 | python3 -c 'import sys,json; print(json.load(sys.stdin)["project"]["id"])')
echo "$PID" > "$RF_E2E_WORK/project"
"${CLI[@]}" media import "$PID" "$M/wide.mp4" "$M/C001_Espresso.mp4" "$M/C004_Beans.mp4" "$M/Cafe_Mood.wav" >/dev/null
python3 "$HERE/populate.py"

# ── Engine + relay + pairing ────────────────────────────────────────────────
# `serve` exits when stdin closes, so keep it open.
REELFORGE_API_TOKEN="$RF_E2E_TOKEN" sh -c "tail -f /dev/null | exec ${CLI[*]} serve --port $ENGINE_PORT" >"$RF_E2E_WORK/serve.log" 2>&1 &
ENGINE_PID=$!
disown "$ENGINE_PID"
for _ in $(seq 50); do curl -s -o /dev/null "$ENGINE/v1/health" && break; sleep 0.2; done
RELAY_AUTH=$(curl -s -H "$AUTH_H" "$ENGINE/v1/remote" | python3 -c 'import sys,json; print(json.load(sys.stdin)["remote"]["relayAuth"])')
PORT="$RELAY_PORT" REELFORGE_REMOTE_AUTH="$RELAY_AUTH" nohup node "$ROOT/apps/remote/server.mjs" >"$RF_E2E_WORK/relay.log" 2>&1 &
disown $!
for _ in $(seq 50); do curl -s -o /dev/null "http://127.0.0.1:$RELAY_PORT/" && break; sleep 0.2; done
curl -s -H "$AUTH_H" -H 'content-type: application/json' -d "{\"url\":\"http://127.0.0.1:$RELAY_PORT\"}" "$ENGINE/v1/remote/start" >/dev/null
sleep 1.5
curl -s -H "$AUTH_H" -X POST "$ENGINE/v1/remote/pairing" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["remote"]["pairing"]["code"])' >"$RF_E2E_WORK/pairing.txt"

# ── Phone ───────────────────────────────────────────────────────────────────
status=0
python3 "$HERE/scenario.py" || status=1
python3 "$HERE/pinch.py" || status=1
[ "$status" = 0 ] && echo "remote-edit e2e: all passed" || echo "remote-edit e2e: FAILED (rerun with KEEP=1 for screenshots and logs)"
exit "$status"
