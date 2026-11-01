#!/bin/sh
# Make sure the data folder is writable by the app user, then drop root.
# (A host folder mounted at /data is often created by Docker as root.)
#
# Changing the owner of every file takes minutes on a shared Windows/macOS drive once the data folder holds a big
# TMDB cache (100,000+ small files), so it's only done when the app can't already write there. Folders and files
# down to two levels are checked (that's quick: the big cache folders themselves are checked, not each file in them).
set -e
DATA="${DATA_DIR:-/data}"
writable() { # user:group
  su-exec "$1" sh -c '[ -w "$1" ] && [ -x "$1" ] || exit 1; for f in "$1"/* "$1"/*/*; do [ -e "$f" ] || continue; [ -w "$f" ] || exit 1; done' sh "$DATA"
}
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA"
  if [ -n "$PUID" ] || [ -n "$PGID" ]; then
    # Run as a specific host user, e.g. PUID=1000 PGID=1000
    U="${PUID:-1000}"; G="${PGID:-$U}"
    writable "$U:$G" || { echo "Giving $U:$G the data folder (once)…"; chown -R "$U:$G" "$DATA" 2>/dev/null || true; }
    exec su-exec "$U:$G" "$@"
  fi
  writable node:node || { echo "Giving the app user the data folder (once)…"; chown -R node:node "$DATA" 2>/dev/null || true; }
  exec su-exec node "$@"
fi
exec "$@"
