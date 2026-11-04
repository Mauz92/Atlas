#!/usr/bin/env bash
# S6: signed-update flow on Linux (AppImage) against a LOCAL static server (127.0.0.1:18777, plain http, only possible
# because the spike sets dangerousInsecureTransportProtocol). Three cases: valid, tampered bundle, bundle signed by another key.
# Usage: WORK=<dir with dist/ and keys/ from build-bundles.sh> scripts/updater-test.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; WORK="${WORK:?}"
V1="$WORK/dist/v1/Atlas Spike_0.1.0_amd64.AppImage"; V2="Atlas Spike_0.2.0_amd64.AppImage"
export WEBKIT_DISABLE_DMABUF_RENDERER=1
[[ -f "$WORK/keys/other.key" ]] || (cd "$HERE" && npx tauri signer generate -w "$WORK/keys/other.key" -p "" -f >/dev/null)
latest() { python3 - "$1" "$2" <<'PY'
import json,sys
d,sig=sys.argv[1:3]
json.dump({"version":"0.2.0","notes":"spike","pub_date":"2026-11-04T00:00:00Z","platforms":{"linux-x86_64":{"signature":open(sig).read().strip(),"url":"http://127.0.0.1:18777/Atlas%20Spike_0.2.0_amd64.AppImage"}}},open(d+"/latest.json","w"))
PY
}
rm -rf "$WORK/srv"; mkdir -p "$WORK/srv/valid" "$WORK/srv/tampered" "$WORK/srv/wrongkey"
cp "$WORK/dist/v2/$V2" "$WORK/srv/valid/"; latest "$WORK/srv/valid" "$WORK/dist/v2/$V2.sig"
cp "$WORK/dist/v2/$V2" "$WORK/srv/tampered/"; python3 -c "
import sys;p=sys.argv[1];b=bytearray(open(p,'rb').read());b[-100000]^=0xFF;open(p,'wb').write(b)" "$WORK/srv/tampered/$V2"; latest "$WORK/srv/tampered" "$WORK/dist/v2/$V2.sig"
cp "$WORK/dist/v2/$V2" "$WORK/srv/wrongkey/"; (cd "$HERE" && npx tauri signer sign -f "$WORK/keys/other.key" -p "" "$WORK/srv/wrongkey/$V2" >/dev/null 2>&1); latest "$WORK/srv/wrongkey" "$WORK/srv/wrongkey/$V2.sig"
for CASE in valid tampered wrongkey; do
  RUN="$WORK/run-$CASE"; rm -rf "$RUN"; mkdir -p "$RUN/out"; cp "$V1" "$RUN/Atlas.AppImage"
  node "$HERE/scripts/update-server.mjs" "$WORK/srv/$CASE" 18777 & SRV=$!
  sleep 0.5
  SPIKE_SUITE=updater SPIKE_OUT="$RUN/out" timeout 120 "$RUN/Atlas.AppImage" || echo "exit status $?"
  kill $SRV
  echo "== $CASE: $(cat "$RUN/out/updater.json" | tr -d '\n ')"
  echo "   AppImage after: $(sha256sum "$RUN/Atlas.AppImage" | cut -c1-16) (v1 was $(sha256sum "$V1" | cut -c1-16), v2 is $(sha256sum "$WORK/dist/v2/$V2" | cut -c1-16))"
  SPIKE_SUITE=probe SPIKE_OUT="$RUN/out2" timeout 60 "$RUN/Atlas.AppImage" >/dev/null 2>&1 || true
  echo "   version when started again: $(python3 -c "import json;print(json.load(open('$RUN/out2/harness-probe.json'))['ctx']['app_version'])" 2>&1 | tail -1)"
done
