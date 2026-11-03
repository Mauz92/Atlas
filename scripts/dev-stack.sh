#!/usr/bin/env bash
# Atlas local dev stack: API + worker + Vite dev server (the database container is NOT managed here).
#
#   scripts/dev-stack.sh start|stop|restart|status
#
# Default is localhost-only. To reach the dev UI from other devices over the private Tailscale
# network (or the LAN), choose the interface the Vite dev server binds to:
#
#   ATLAS_DEV_BIND=tailscale scripts/dev-stack.sh restart   # the `tailscale ip -4` address
#   ATLAS_DEV_BIND=192.168.1.208 scripts/dev-stack.sh restart   # one specific private LAN address
#
# Only Vite is exposed (it proxies /api and /health to the API). The API (127.0.0.1:8000), the worker
# and PostgreSQL always stay on loopback. Wildcard binds (0.0.0.0, ::) and public addresses are refused.
# The dev stack speaks plain HTTP: see docs/DEPLOYMENT.md "Dev stack on the tailnet" and docs/SECURITY.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="${ATLAS_DEV_RUN_DIR:-$ROOT/data/dev/run}"   # pid files and logs (data/ is git-ignored)
WEB_PORT="${ATLAS_DEV_WEB_PORT:-5173}"
API_PORT="${ATLAS_DEV_API_PORT:-8000}"

resolve_bind() {
  local bind="${ATLAS_DEV_BIND:-127.0.0.1}"
  if [[ "$bind" == "tailscale" ]]; then
    bind="$(tailscale ip -4 | head -n1)"
    [[ -n "$bind" ]] || { echo "tailscale ip -4 returned nothing; is Tailscale up?" >&2; exit 1; }
  fi
  if [[ ! "$bind" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "ATLAS_DEV_BIND must be an IPv4 address or 'tailscale' (got '$bind')" >&2; exit 1
  fi
  # Allow loopback, Tailscale CGNAT (100.64.0.0/10) and RFC 1918 only; never wildcard or public.
  if ! [[ "$bind" =~ ^127\. || "$bind" =~ ^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\. \
        || "$bind" =~ ^10\. || "$bind" =~ ^192\.168\. || "$bind" =~ ^172\.(1[6-9]|2[0-9]|3[01])\. ]]; then
    echo "refusing to bind the dev server to '$bind' (not loopback, tailnet or private LAN)" >&2; exit 1
  fi
  echo "$bind"
}

alive() { [[ -f "$RUN_DIR/$1.pid" ]] && kill -0 "$(cat "$RUN_DIR/$1.pid")" 2>/dev/null; }

start_one() { # name, command...
  local name="$1"; shift
  if alive "$name"; then echo "$name already running (pid $(cat "$RUN_DIR/$name.pid"))"; return; fi
  setsid nohup "$@" >"$RUN_DIR/$name.log" 2>&1 </dev/null &
  echo $! >"$RUN_DIR/$name.pid"
  echo "started $name (pid $!)"
}

cmd_start() {
  local bind; bind="$(resolve_bind)"
  mkdir -p "$RUN_DIR" "$ROOT/data/dev/notes" "$ROOT/data/dev/backups" "$ROOT/data/dev/exports"
  export ATLAS_ENV=development          # cookies are not Secure in development, so login works over plain HTTP
  export DATABASE_URL="${DATABASE_URL:-postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas}"
  export NOTES_ROOT="${NOTES_ROOT:-$ROOT/data/dev/notes}"
  export BACKUP_DIR="${BACKUP_DIR:-$ROOT/data/dev/backups}"
  export EXPORT_DIR="${EXPORT_DIR:-$ROOT/data/dev/exports}"
  export PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-http://$bind:$WEB_PORT}"
  export ATLAS_API_PROXY_TARGET="http://127.0.0.1:$API_PORT"
  ( cd "$ROOT/services/api" && start_one api .venv/bin/uvicorn atlas.main:app --host 127.0.0.1 --port "$API_PORT" )
  ( cd "$ROOT/services/api" && start_one worker .venv/bin/atlas-worker )
  ( cd "$ROOT/apps/web" && start_one web node_modules/.bin/vite --host "$bind" --port "$WEB_PORT" --strictPort )
  echo "open: http://$bind:$WEB_PORT"
}

cmd_stop() {
  for name in web worker api; do
    if alive "$name"; then kill "$(cat "$RUN_DIR/$name.pid")" && echo "stopped $name"; fi
    rm -f "$RUN_DIR/$name.pid"
  done
}

case "${1:-}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  restart) cmd_stop; sleep 1; cmd_start ;;
  status) for n in api worker web; do alive "$n" && echo "$n: running ($(cat "$RUN_DIR/$n.pid"))" || echo "$n: stopped"; done ;;
  *) echo "usage: $0 start|stop|restart|status" >&2; exit 2 ;;
esac
