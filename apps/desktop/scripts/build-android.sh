#!/usr/bin/env bash
# Build the Atlas Android app (SYNC-10, ADR-0075). Usage: scripts/build-android.sh [debug|release] [aarch64|armv7|i686|x86_64|all]
# Needs: JDK 17, Android SDK (platform 35+, build-tools, platform-tools), NDK 27, the four Rust android targets, node, and
# `npm run build` output in apps/web (done here). Environment defaults to ~/.local/android (see docs/ANDROID.md).
# The Gradle project under src-tauri/gen/android is generated (gitignored); the patch below is the whole customisation.
set -euo pipefail
cd "$(dirname "$0")/.."
export ANDROID_HOME="${ANDROID_HOME:-$HOME/.local/android/sdk}"
export JAVA_HOME="${JAVA_HOME:-$HOME/.local/android/jdk17}"
export NDK_HOME="${NDK_HOME:-$(ls -d "$ANDROID_HOME"/ndk/27.* | head -1)}"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$HOME/.cargo/bin:$PATH"
PROFILE="${1:-debug}"; TARGET="${2:-aarch64}"
# `play` (PLAY-01, docs/PLAY_STORE.md) = a release App Bundle (.aab) without MANAGE_EXTERNAL_STORAGE, for the Play Console. Default target for
# it is `all` because Play wants every ABI in one bundle; the sideload APK builds above are unchanged.
if [ "$PROFILE" = play ]; then export ATLAS_PLAY=1; TARGET="${2:-all}"; else export ATLAS_PLAY=0; fi

(cd ../web && npm ci --silent && npm run build --silent)
[ -d node_modules/@tauri-apps ] || npm ci --silent
node scripts/stage-ui.mjs

GEN=src-tauri/gen/android
if [ ! -d "$GEN" ]; then npx tauri android init --ci; fi
node scripts/patch-android.mjs "$GEN"

ARGS=(--apk)
[ "$PROFILE" = debug ] && ARGS+=(--debug)
[ "$PROFILE" = play ] && ARGS=(--aab)
[ "$TARGET" != all ] && ARGS+=(--target "$TARGET")
# ATLAS_VERSION (the release workflow, REL-02) overrides the version in tauri.conf.json for this build only, like build-linux.sh.
[ -n "${ATLAS_VERSION:-}" ] && ARGS+=(--config "{\"version\":\"$ATLAS_VERSION\"}")
npx tauri android build "${ARGS[@]}"
if [ "$PROFILE" = play ]; then
  find "$GEN/app/build/outputs/bundle" -name '*.aab' -newer scripts/patch-android.mjs -print
else
  find "$GEN/app/build/outputs/apk" -name '*.apk' -newer scripts/patch-android.mjs -print
fi
