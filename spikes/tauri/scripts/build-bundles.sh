#!/usr/bin/env bash
# Build signed AppImages v0.1.0 and v0.2.0 (+ the .deb of v0.1.0) with a THROWAWAY test key into $WORK/dist.
# Usage: WORK=/some/dir scripts/build-bundles.sh      (key pair is generated in $WORK/keys if missing; never publish these)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$HERE"
WORK="${WORK:?set WORK to a scratch directory}"; mkdir -p "$WORK/keys" "$WORK/dist/v1" "$WORK/dist/v2"
[[ -f "$WORK/keys/test.key" ]] || npx tauri signer generate -w "$WORK/keys/test.key" -p "" -f >/dev/null
PUB="$(cat "$WORK/keys/test.key.pub")"
export TAURI_SIGNING_PRIVATE_KEY="$(cat "$WORK/keys/test.key")" TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
npx esbuild ui/src/harness.js --bundle --format=iife --outfile=ui/harness.bundle.js --log-level=warning
# The public key of the throwaway pair goes into the build through --config (tauri.conf.json keeps the key used in the spike runs).
CFG1="{\"version\":\"0.1.0\",\"plugins\":{\"updater\":{\"pubkey\":\"$PUB\"}}}"
CFG2="{\"version\":\"0.2.0\",\"plugins\":{\"updater\":{\"pubkey\":\"$PUB\"}}}"
npx tauri build -c "$CFG1" --bundles appimage deb
cp target/release/bundle/appimage/*0.1.0*.AppImage* "$WORK/dist/v1/"; cp target/release/bundle/deb/*0.1.0*.deb "$WORK/dist/v1/"
npx tauri build -c "$CFG2" --bundles appimage
cp target/release/bundle/appimage/*0.2.0*.AppImage* "$WORK/dist/v2/"
rm -rf target/release/bundle/appimage/*.AppDir
ls -la "$WORK/dist/v1" "$WORK/dist/v2"
