#!/bin/sh
# Runs the app under Litestream replication when all five LITESTREAM_* vars are
# present; otherwise runs the server plain. The app reads PORT (default 6543) and
# serves via waitress (see runapp.py). Working dir must stay /app so the Jinja
# template loader and favicon relative paths resolve.
set -eu

if [ -n "${LITESTREAM_ACCESS_KEY_ID:-}" ] \
  && [ -n "${LITESTREAM_SECRET_ACCESS_KEY:-}" ] \
  && [ -n "${LITESTREAM_BUCKET:-}" ] \
  && [ -n "${LITESTREAM_ENDPOINT:-}" ] \
  && [ -n "${LITESTREAM_REGION:-}" ]; then
  # Auto-restore on a fresh/empty volume (no-op if the DB already exists or no
  # replica is present yet), then replicate while the server runs.
  litestream restore -config /app/litestream.yml \
    -if-db-not-exists -if-replica-exists "${TWITCH_SESSION_DB:-/app/data/multistream.sqlite3}"
  exec litestream replicate -config /app/litestream.yml -exec "python runapp.py"
fi

exec python runapp.py
