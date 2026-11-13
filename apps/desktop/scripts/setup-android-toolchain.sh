#!/usr/bin/env bash
# Installs the Android build toolchain in user space (no sudo), idempotently, with pinned download checksums (ADR-0075, docs/DEPENDENCIES.md):
# Temurin JDK 17.0.21+9, Android command-line tools 11076708, platform 35 + 36, build-tools 35.0.0, platform-tools, NDK 27.2.12479018.
# Accepting the Android SDK licences is the operator's decision: this script does it because you ran it (set ANDROID_ACCEPT_LICENSES=no to stop).
# Usage: scripts/setup-android-toolchain.sh [dir]   (default $ANDROID_TOOLCHAIN_DIR or ~/.local/android). Prints the exports to use.
set -euo pipefail
DIR="${1:-${ANDROID_TOOLCHAIN_DIR:-$HOME/.local/android}}"
mkdir -p "$DIR/dl"; cd "$DIR"
JDK_URL="https://api.adoptium.net/v3/binary/version/jdk-17.0.21%2B9/linux/x64/jdk/hotspot/normal/eclipse"
JDK_SHA=8b9b611d917e3dfd8419d3566b5949226f69b052fed7e109c1368add1dfe8711
CMD_URL="https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip"
CMD_SHA=2d2d50857e4eb553af5a6dc3ad507a17adf43d115264b1afc116f95c92e5e258
fetch() { # url sha file
  [ -f "dl/$3" ] || curl -fsSL --retry 3 -o "dl/$3" "$1"
  echo "$2  dl/$3" | sha256sum -c - >/dev/null || { echo "checksum mismatch for $3" >&2; rm -f "dl/$3"; exit 1; }
}
if [ ! -x jdk17/bin/java ]; then
  fetch "$JDK_URL" "$JDK_SHA" jdk17.tar.gz
  tar xzf dl/jdk17.tar.gz && rm -rf jdk17 && mv jdk-17* jdk17
fi
if [ ! -x sdk/cmdline-tools/latest/bin/sdkmanager ]; then
  fetch "$CMD_URL" "$CMD_SHA" cmdtools.zip
  mkdir -p sdk/cmdline-tools && unzip -q -o dl/cmdtools.zip -d sdk/cmdline-tools && rm -rf sdk/cmdline-tools/latest && mv sdk/cmdline-tools/cmdline-tools sdk/cmdline-tools/latest
fi
export JAVA_HOME="$DIR/jdk17" ANDROID_HOME="$DIR/sdk"
SDKM="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
if [ "${ANDROID_ACCEPT_LICENSES:-yes}" = yes ]; then yes | "$SDKM" --licenses >/dev/null 2>&1 || true; fi
"$SDKM" "platform-tools" "platforms;android-35" "platforms;android-36" "build-tools;35.0.0" "ndk;27.2.12479018" >/dev/null
echo "export JAVA_HOME=$DIR/jdk17 ANDROID_HOME=$DIR/sdk NDK_HOME=$DIR/sdk/ndk/27.2.12479018"
