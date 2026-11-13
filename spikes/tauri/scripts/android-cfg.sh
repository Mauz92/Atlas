#!/usr/bin/env bash
# Usage: android-cfg.sh '{"suite":"s5,hold","delay":"60"}'   (debug builds only; uses run-as)
# Pushes the harness config to the app's data dir (spike.json) and clears previous reports.
set -euo pipefail
export PATH="$HOME/.local/android/sdk/platform-tools:$PATH"
PKG=app.atlas.spike
tmp=$(mktemp); printf '%s' "$1" > "$tmp"
adb push -q "$tmp" /data/local/tmp/spike.json; rm -f "$tmp"
adb shell run-as $PKG cp /data/local/tmp/spike.json spike.json
adb shell rm /data/local/tmp/spike.json
