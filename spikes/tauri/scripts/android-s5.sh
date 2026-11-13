#!/usr/bin/env bash
# S5: schedule a local notification DELAY seconds ahead, kill the process (not force-stop: that would cancel alarms), screen off,
# optional `adb shell dumpsys deviceidle force-idle`, then report how late it posted. Usage: android-s5.sh DELAY NID [idle]
set -euo pipefail
export PATH="$HOME/.local/android/sdk/platform-tools:$PATH"
PKG=app.atlas.spike; D=${1:-60}; NID=${2:-1}; MODE=${3:-}
adb shell am force-stop $PKG
"$(dirname "$0")/android-cfg.sh" "{\"suite\":\"s5\",\"delay\":\"$D\",\"idle\":\"1\",\"nid\":\"$NID\"}"
adb shell run-as $PKG rm -f out/harness-s5.json
adb shell input keyevent KEYCODE_WAKEUP; adb shell wm dismiss-keyguard
adb shell am start -n $PKG/.MainActivity >/dev/null
for _ in $(seq 1 20); do adb shell run-as $PKG test -f out/harness-s5.json 2>/dev/null && break; sleep 1; done
SCHED=$(adb shell run-as $PKG cat out/harness-s5.json | python3 -c "import json,sys; print(json.load(sys.stdin)['s5']['scheduled_for'])")
adb shell am kill $PKG; sleep 1; adb shell input keyevent KEYCODE_SLEEP
echo "process after kill: $(adb shell pidof $PKG || echo none); scheduled_for=$SCHED"
if [ "$MODE" = idle ]; then adb shell dumpsys deviceidle force-idle | tail -1; fi
sleep $((D + 75))
adb shell dumpsys deviceidle unforce >/dev/null 2>&1 || true
WHEN=$(adb shell dumpsys notification --noredact | grep -A40 "pkg=$PKG" | grep -m1 "when=" | sed 's/.*when=//' | tr -d '\r ')
python3 - "$SCHED" "$WHEN" <<'PY'
import sys,datetime as d
s=d.datetime.fromisoformat(sys.argv[1].replace('Z','+00:00'))
if not sys.argv[2]: print("NOT POSTED within delay+75 s"); sys.exit(0)
w=d.datetime.fromtimestamp(int(sys.argv[2])/1000,d.timezone.utc)
print("posted", w.isoformat(), "late by", round((w-s).total_seconds(),2), "s")
PY
