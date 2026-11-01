#!/bin/sh
# Make sure the data folder is writable by the app user, then drop root.
# (A host folder mounted at /data is often created by Docker as root.)
set -e
DATA="${DATA_DIR:-/data}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA"
  if [ -n "$PUID" ] || [ -n "$PGID" ]; then
    # Run as a specific host user, e.g. PUID=1000 PGID=1000
    U="${PUID:-1000}"; G="${PGID:-$U}"
    chown -R "$U:$G" "$DATA" 2>/dev/null || true
    exec su-exec "$U:$G" "$@"
  fi
  chown -R node:node "$DATA" 2>/dev/null || true
  exec su-exec node "$@"
fi
exec "$@"
