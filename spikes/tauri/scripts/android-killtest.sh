#!/usr/bin/env bash
# S2 on a device: start the app (worker thread commits pages in a loop), force-stop it after a random 20-300 ms, repeat.
# Every start verifies the database first (see killtest() in lib.rs). Usage: android-killtest.sh [iterations]
set -euo pipefail
export PATH="$HOME/.local/android/sdk/platform-tools:$PATH"
PKG=app.atlas.spike; N=${1:-100}
"$(dirname "$0")/android-cfg.sh" '{"suite":"killtest,hold"}'
adb shell am force-stop $PKG
adb shell run-as $PKG rm -f out/kill.log kill.db kill.db-wal kill.db-shm
for i in $(seq 1 "$N"); do
  prev=$(adb shell run-as $PKG sh -c "'wc -l < out/kill.log 2>/dev/null || echo 0'" | tr -d "\r "); adb shell am start -n $PKG/.MainActivity >/dev/null
  # wait until the worker has verified the database (one new log line), so the kill lands while it is committing
  for _ in $(seq 1 40); do
    c=$(adb shell run-as $PKG sh -c "'wc -l < out/kill.log 2>/dev/null || echo 0'" | tr -d '\r ')
    [ "${c:-0}" -gt "$prev" ] && break
  done
  sleep "0.$(( (RANDOM % 280) + 20 ))"
  adb shell am force-stop $PKG
done
adb shell am start -n $PKG/.MainActivity >/dev/null; sleep 3; adb shell am force-stop $PKG
adb shell run-as $PKG cat out/kill.log | sort | uniq -c | sort -rn | head -5
adb shell run-as $PKG cat out/kill.log | awk '{print $1}' | sort | uniq -c
