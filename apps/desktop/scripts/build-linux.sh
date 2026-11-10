#!/usr/bin/env bash
# Build the Atlas desktop app for Linux (SYNC-09e): AppImage and .deb, from a clean checkout, with no network access other
# than the (checksum-pinned) bundler tools and the locked crates/packages.
#
#   scripts/build-linux.sh              product build: AppImage + .deb into apps/desktop/out/current/  (the previous
#                                       AppImage is kept in out/previous/ = the rollback)
#   scripts/build-linux.sh e2e          debug binary with the test hooks, for e2e/run.mjs (never given to a person)
#
# Requirements (Arch: `pacman -S --needed webkit2gtk-4.1 gtk3 libayatana-appindicator librsvg openssl base-devel`; Debian/Ubuntu:
# libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev build-essential), Rust (rustup, stable),
# Node 22+. Nothing here needs sudo, signs anything, or publishes anything.
set -euo pipefail
MODE="${1:-product}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
# shellcheck disable=SC1091
[[ -f "$HOME/.cargo/env" ]] && source "$HOME/.cargo/env"
cd "$HERE"

echo "== web UI =="
(cd "$ROOT/apps/web" && { [[ -d node_modules ]] || npm ci --no-audit --no-fund >/dev/null; } && npm run build >/dev/null)
echo "== desktop frontend =="
[[ -d node_modules ]] || npm ci --no-audit --no-fund >/dev/null
npm run stage

if [[ "$MODE" == "e2e" ]]; then
  TAURI_CONFIG="$(cat src-tauri/tauri.e2e.conf.json)" cargo build --locked -p atlas-desktop --features custom-protocol,e2e
  echo "binary: $HERE/target/debug/atlas-desktop"
  exit 0
fi

echo "== bundler tools (pinned) =="
scripts/fetch-bundler-tools.sh
export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-$(git -C "$ROOT" log -1 --format=%ct 2>/dev/null || date +%s)}"
export RUSTFLAGS="${RUSTFLAGS:-} --remap-path-prefix=$HOME=/home/build --remap-path-prefix=$HERE=/src/atlas-desktop"
export NO_STRIP=1   # linuxdeploy's bundled `strip` cannot read newer ELF sections (.relr.dyn); the release profile already strips the binary
echo "== bundles =="
# ATLAS_VERSION (the release workflow, REL-01) overrides the version in tauri.conf.json for this build only.
VERSION="${ATLAS_VERSION:-$(node -p "require('./src-tauri/tauri.conf.json').version")}"
npx tauri build --bundles appimage deb --config "{\"version\":\"$VERSION\"}" -- --locked
BUNDLES="$HERE/target/release/bundle"
mkdir -p out/current out/previous
for old in out/current/*.AppImage; do [[ -e "$old" ]] && mv -f "$old" out/previous/; done
cp "$BUNDLES"/appimage/Atlas_"$VERSION"_amd64.AppImage out/current/
cp "$BUNDLES"/deb/Atlas_"$VERSION"_amd64.deb out/current/
(cd out/current && sha256sum -- *.AppImage *.deb > SHA256SUMS && cat SHA256SUMS && ls -l)
echo "Rollback: out/previous/ holds the AppImage that was current before this build."
