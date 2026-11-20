#!/bin/sh
# Increase ROAS wrapper around Paperclip's scripts/docker-entrypoint.sh.
# Keeps the behaviours the live (Hostinger) image's /entrypoint.sh had that
# Paperclip's own entrypoint does not do.
set -e

# Codex reads CODEX_API_KEY; live exported it from OPENAI_API_KEY.
if [ -n "${OPENAI_API_KEY:-}" ] && [ -z "${CODEX_API_KEY:-}" ]; then
  export CODEX_API_KEY="$OPENAI_API_KEY"
fi

# Remove a stale embedded-Postgres pid file left by an unclean stop.
PIDFILE="${PAPERCLIP_HOME:-/paperclip}/instances/${PAPERCLIP_INSTANCE_ID:-default}/db/postmaster.pid"
if [ -f "$PIDFILE" ]; then
  pid="$(head -n1 "$PIDFILE" 2>/dev/null || true)"
  if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
    echo "ir-entrypoint.sh: removing stale postmaster.pid (pid=$pid not alive)"
    rm -f "$PIDFILE"
  fi
fi

exec docker-entrypoint.sh "$@"
