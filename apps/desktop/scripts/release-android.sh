#!/usr/bin/env bash
# Build, sign and verify the Android APK for a release, and (only with --upload) attach it to the GitHub Release (REL-02).
# The signing key stays in your own account (apps/desktop/keys/): the CI runner is a separate user and never sees it (R-85).
#
#   scripts/release-android.sh 0.1.0             build + verify; the APK lands in apps/desktop/out/android/
#   scripts/release-android.sh 0.1.0 --upload    ...and add it (and its checksum) to the existing release v0.1.0
#
# Run it after the tag pipeline has published the release. Needs the toolchain of build-android.sh and an authenticated `gh`.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="${1:?usage: release-android.sh X.Y.Z [--upload]}"
[[ "$VERSION" =~ ^[0-9]{1,4}\.[0-9]{1,5}\.[0-9]{1,5}$ ]] || { echo "'$VERSION' is not X.Y.Z" >&2; exit 1; }
UPLOAD="${2:-}"
# The release to attach to; default is the pipeline's v<version>. RELEASE_TAG=android-v0.1.0 targets a separate pre-release (see below).
TAG="${RELEASE_TAG:-v$VERSION}"
[ -f keys/android-signing.properties ] || { echo "keys/android-signing.properties is missing: run scripts/android-keystore.sh (or restore your key)" >&2; exit 1; }
export ANDROID_HOME="${ANDROID_HOME:-$HOME/.local/android/sdk}"
export JAVA_HOME="${JAVA_HOME:-$HOME/.local/android/jdk17}"   # apksigner needs java on the PATH
export PATH="$JAVA_HOME/bin:$PATH"

ATLAS_VERSION="$VERSION" scripts/build-android.sh release aarch64

APK=src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
[ -f "$APK" ] || { echo "no release APK at $APK" >&2; exit 1; }
APKSIGNER="$(ls -d "$ANDROID_HOME"/build-tools/*/apksigner | sort -V | tail -1)"
"$APKSIGNER" verify --verbose --print-certs "$APK" | tee /tmp/atlas-apksigner.txt
grep -q "Verified using v[23] scheme.*: true" /tmp/atlas-apksigner.txt || { echo "the APK is not signed" >&2; exit 1; }

OUT=out/android
mkdir -p "$OUT"
NAME="Atlas_${VERSION}_android-arm64.apk"
cp "$APK" "$OUT/$NAME"
(cd "$OUT" && sha256sum "$NAME" | tee "$NAME.sha256")
echo "built $PWD/$OUT/$NAME"

if [ "$UPLOAD" = "--upload" ]; then
  gh release view "$TAG" >/dev/null || { echo "no GitHub release $TAG yet: push the tag and let the pipeline finish first (or create a pre-release and set RELEASE_TAG)" >&2; exit 1; }
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  gh release download "$TAG" --pattern SHA256SUMS --dir "$TMP" || true
  touch "$TMP/SHA256SUMS"
  grep -v " $NAME\$" "$TMP/SHA256SUMS" > "$TMP/SHA256SUMS.new" || true
  (cd "$OUT" && sha256sum "$NAME") >> "$TMP/SHA256SUMS.new"
  mv "$TMP/SHA256SUMS.new" "$TMP/SHA256SUMS"
  gh release upload "$TAG" "$OUT/$NAME" "$TMP/SHA256SUMS" --clobber
  echo "attached $NAME to $TAG"
else
  echo "not uploaded (add --upload to attach it to release $TAG)"
fi
