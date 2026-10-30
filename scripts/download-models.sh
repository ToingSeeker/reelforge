#!/usr/bin/env bash
# Download the local speech models ReelForge uses, verified by SHA-256.
#   ggml-large-v3-turbo.bin  (~1.6 GB)  whisper.cpp speech recognition
#   ggml-silero-v6.2.0.bin   (~0.9 MB)  voice activity detection (stops whisper "hearing" words in music)
# Destination: $REELFORGE_MODELS, or the ReelForge app-data folder.
set -euo pipefail

case "$(uname)" in
  Darwin) DEFAULT="$HOME/Library/Application Support/ReelForge/models" ;;
  *) DEFAULT="${XDG_DATA_HOME:-$HOME/.local/share}/reelforge/models" ;;
esac
DEST="${REELFORGE_MODELS:-$DEFAULT}"
mkdir -p "$DEST"

fetch() { # repo file sha256
  local out="$DEST/$2"
  if [ -f "$out" ] && echo "$3  $out" | shasum -a 256 -c - >/dev/null 2>&1; then
    echo "ok       $2"
    return
  fi
  echo "download $2"
  curl -fL --progress-bar -o "$out.part" "https://huggingface.co/$1/resolve/main/$2"
  echo "$3  $out.part" | shasum -a 256 -c - >/dev/null || { echo "checksum mismatch for $2"; rm -f "$out.part"; exit 1; }
  mv "$out.part" "$out"
}

fetch ggerganov/whisper.cpp ggml-large-v3-turbo.bin 1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69
fetch ggml-org/whisper-vad ggml-silero-v6.2.0.bin 2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987
command -v whisper-cli >/dev/null || echo "note: install whisper.cpp too (macOS: brew install whisper-cpp)"
echo "models in $DEST"
