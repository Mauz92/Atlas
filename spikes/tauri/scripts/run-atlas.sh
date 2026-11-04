#!/usr/bin/env bash
# S1: load the EXISTING web UI (served by scripts/serve.mjs from the throwaway stack) in the Tauri/WebKitGTK window,
# run ui/scenario.js, write snapshots + facts to $SPIKE_OUT. Usage: scripts/run-atlas.sh [desktop|phone]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export SPIKE_OUT="${SPIKE_OUT:-$HERE/out}"; STATE="$SPIKE_OUT/stack.json"
SIZE="${1:-desktop}"
read -r WEB EMAIL PASS < <(python3 -c "import json;s=json.load(open('$STATE'));print(s['webPort'],s['owner']['email'],s['owner']['password'])")
export WEBKIT_DISABLE_DMABUF_RENDERER="${WEBKIT_DISABLE_DMABUF_RENDERER:-1}"
export SPIKE_ATLAS_URL="http://127.0.0.1:$WEB/#email=$EMAIL&password=$PASS"
[[ "$SIZE" == phone ]] && export SPIKE_ATLAS_SIZE=390x800 || export SPIKE_ATLAS_SIZE=1280x800
export SPIKE_SUITE=atlas
# A fresh WebKit profile per run (otherwise localStorage, e.g. the chosen theme, leaks from the previous run).
PROFILE="$(mktemp -d)"; trap 'rm -rf "$PROFILE"' EXIT
if [[ "${SPIKE_FRESH_PROFILE:-1}" == 1 ]]; then export XDG_DATA_HOME="$PROFILE/data" XDG_CACHE_HOME="$PROFILE/cache"; mkdir -p "$XDG_DATA_HOME" "$XDG_CACHE_HOME"; fi
rm -f "$SPIKE_OUT/scenario-webkit-$SIZE.json"
timeout "${SPIKE_TIMEOUT:-240}" "${BIN:-$HERE/target/release/atlas-spike}" || echo "exit status $?"
python3 - "$SPIKE_OUT/scenario-webkit-$SIZE.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
sc=d.get('scenario',{})
print('viewport',sc.get('viewport'),'dpr',sc.get('dpr'))
print('steps ok:',sum(1 for v in sc.get('steps',{}).values() if v['ok']),'failed:',{k:v['error'] for k,v in sc.get('steps',{}).items() if not v['ok']})
print('perf',json.dumps(d.get('perf'),indent=1) if d.get('perf') else None)
print('acl',json.dumps(d.get('acl'),indent=1))
if 'crashed' in d: print('CRASHED',d['crashed'])
PY
