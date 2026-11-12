#!/bin/sh
# Sets up "Subtitles made from the sound" for a Docker install: builds whisper.cpp's program for the app's image and
# fetches a model, both into <the server's folder>/data/whisper, where the app looks. Changes nothing else.
#
#   sh tools/whisper/setup-whisper.sh [model] [the server's folder]
#
# model: tiny, base, small (the default), medium, large-v3-turbo … — bigger is more accurate and slower.
set -e
MODEL="${1:-small}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$2"
if [ -z "$ROOT" ]; then
  for d in "$HERE/../.." "$HERE/../../.." "$PWD"; do
    if [ -f "$d/docker-compose.yml" ] && [ -d "$d/data" ]; then ROOT="$(cd "$d" && pwd)"; break; fi
  done
fi
[ -n "$ROOT" ] || { echo "Couldn't find the server's folder (the one with docker-compose.yml and data). Give it as the second argument."; exit 1; }
OUT="$ROOT/data/whisper"
mkdir -p "$OUT"
echo "Step 1 of 2: building whisper.cpp for the app's image (a few minutes the first time)..."
docker build --output "type=local,dest=$OUT" "$HERE"
chmod +x "$OUT/whisper-cli" 2>/dev/null || true
[ -f "$OUT/whisper-cli" ] || { echo "The program wasn't made."; exit 1; }
echo "Step 2 of 2: the \"$MODEL\" model..."
if [ -s "$OUT/ggml-$MODEL.bin" ]; then echo "Already there."; else
  curl -L --fail --progress-bar -o "$OUT/ggml-$MODEL.bin.part" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$MODEL.bin"
  mv "$OUT/ggml-$MODEL.bin.part" "$OUT/ggml-$MODEL.bin"
fi
echo "Done: $OUT"
echo "Restart the server (or Admin > Integrations > Subtitles made from the sound > Look again)."
