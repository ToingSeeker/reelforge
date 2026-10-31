#!/bin/bash
# Development setup for AI effects: a Python venv for packages/fx-engine with the pinned
# packages (requirements.txt, installed without their optional extras). Release builds bundle
# their own Python instead (scripts/release/build-engine.mjs).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE="$HERE/packages/fx-engine"
PY="${PYTHON:-}"
if [ -z "$PY" ]; then
  for c in python3.12 python3.11 python3; do
    if command -v "$c" >/dev/null && "$c" -c 'import sys; sys.exit(0 if (3, 11) <= sys.version_info[:2] <= (3, 12) else 1)'; then PY="$c"; break; fi
  done
fi
[ -n "$PY" ] || { echo "Need Python 3.11 or 3.12 (brew install python@3.12), or set PYTHON=…"; exit 1; }
"$PY" -m venv "$ENGINE/.venv"
"$ENGINE/.venv/bin/python" -m pip install --quiet --disable-pip-version-check --no-deps -r "$ENGINE/requirements.txt"
"$ENGINE/.venv/bin/python" -I -c 'import mediapipe, cv2, numpy, PIL; print("AI effects engine ready:", mediapipe.__version__)'
