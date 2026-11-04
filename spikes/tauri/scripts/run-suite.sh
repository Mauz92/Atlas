#!/usr/bin/env bash
# Run one harness suite in the Tauri shell and print its JSON report.
# Usage: scripts/run-suite.sh <suite[,suite...]> [path-to-binary]
#   suites: probe ipc fsscope keystore fetch sync notify
# Needs: SPIKE_OUT (report dir), the throwaway stack (scripts/stack.mjs up ...) for fetch/sync, a display.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUITE="$1"; BIN="${2:-$HERE/target/release/atlas-spike}"
export SPIKE_OUT="${SPIKE_OUT:-$HERE/out}"; mkdir -p "$SPIKE_OUT"
STATE="$SPIKE_OUT/stack.json"
export SPIKE_SUITE="$SUITE"
# WebKitGTK 2.54 on this Wayland session dies with "Error 71 (Protocol error)" without this (see SPIKE.md).
export WEBKIT_DISABLE_DMABUF_RENDERER="${WEBKIT_DISABLE_DMABUF_RENDERER:-1}"
export SPIKE_DB="${SPIKE_DB:-$HERE/target/spike-run/app-$$.db}"; mkdir -p "$(dirname "$SPIKE_DB")"
if [[ -f "$STATE" ]]; then
  export SPIKE_API="http://127.0.0.1:$(python3 -c "import json;print(json.load(open('$STATE'))['apiPort'])")"
  export SPIKE_EMAIL="$(python3 -c "import json;print(json.load(open('$STATE'))['owner']['email'])")"
  export SPIKE_PASSWORD="$(python3 -c "import json;print(json.load(open('$STATE'))['owner']['password'])")"
fi
export SPIKE_NOTES="${SPIKE_NOTES:-/tmp/atlas-spike-run/notes}"
rm -f "$SPIKE_OUT/harness-${SUITE//,/_}.json"
timeout "${SPIKE_TIMEOUT:-90}" "$BIN" || echo "exit status $?"
cat "$SPIKE_OUT/harness-${SUITE//,/_}.json"
