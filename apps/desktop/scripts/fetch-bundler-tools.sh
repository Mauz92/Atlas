#!/usr/bin/env bash
# Install the AppImage bundler tools into ~/.cache/tauri from packaging/bundler-tools.tsv, verifying SHA-256, or stop.
# The spike let the bundler download `linuxdeploy` plugins from a moving `continuous` release unchecked (SYNC-07 S10); this
# script replaces that: a file already in the cache is accepted only if its hash is the pinned one, a missing or different file is
# downloaded from the pinned URL and accepted only if ITS hash is the pinned one. A mismatch is an error (upstream changed or the
# download was tampered with): update the manifest deliberately after reviewing the new tool, never silently.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/tauri"
mkdir -p "$CACHE"
sha() { sha256sum "$1" | cut -d' ' -f1; }
while IFS=$'\t' read -r name url src_sha patch final_sha; do
  [[ -z "${name:-}" || "$name" == \#* ]] && continue
  if [[ -f "$CACHE/$name" && "$(sha "$CACHE/$name")" == "$final_sha" ]]; then echo "ok (cached)  $name"; continue; fi
  tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
  echo "downloading  $name"; curl -fsSL --retry 3 --max-time 300 -o "$tmp" "$url"
  [[ "$(sha "$tmp")" == "$src_sha" ]] || { echo "FAIL: $name downloaded from $url has SHA-256 $(sha "$tmp"), pinned $src_sha" >&2; exit 1; }
  [[ "$patch" == "appimage-magic" ]] && dd if=/dev/zero of="$tmp" bs=1 count=3 seek=8 conv=notrunc 2>/dev/null
  [[ "$(sha "$tmp")" == "$final_sha" ]] || { echo "FAIL: $name after patch has SHA-256 $(sha "$tmp"), pinned $final_sha" >&2; exit 1; }
  install -m 0770 "$tmp" "$CACHE/$name"; rm -f "$tmp"; trap - EXIT
  echo "installed    $name"
done < "$HERE/packaging/bundler-tools.tsv"
