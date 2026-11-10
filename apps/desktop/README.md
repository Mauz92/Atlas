# Atlas desktop app (SYNC-09 phase 1: Linux)

A Tauri 2 shell around the Atlas web UI. Design and rules: `docs/DECISIONS.md` ADR-0069, `docs/ARCHITECTURE.md` section 8a, `docs/SECURITY.md` section 15.
It is **not** part of `scripts/verify.sh` or CI; the framework-neutral parts it uses (`packages/desktop-core`, the adapter test, the web bridge) are tested by `apps/web`'s vitest.

| Path | What |
|---|---|
| `native/` | Rust, no Tauri: `store.rs` (SQLite), `notes.rs` + `watch.rs` (confined folder, watcher), `keystore.rs`, `http.rs` (token attached here), `rules.rs`. `cargo test -p atlas-desktop-native` |
| `src-tauri/` | Tauri commands, tray, window, plugins; `capabilities/main.json` is the whole webview permission list; features `updater` and `e2e` (both off by default) |
| `src/` | `tauriPlatform.ts` (the only file that knows command names), `bridge.ts` (`window.atlasDesktop`, incl. the `sync` verbs of the conflict/notice/restore screens, SYNC-11c), `bootstrap.ts`, the sign-in page |
| `scripts/` | `build-linux.sh` (AppImage + .deb, pinned bundler tools), `fetch-bundler-tools.sh`, `stage-ui.mjs` |
| `e2e/` | `run.mjs` (end-to-end run of the real app against a throwaway API; SYNC-11 added the notices, Settings and two restore steps), `updater-test.mjs` |
| `packaging/` | `bundler-tools.tsv` (SHA-256 pins) |

## Build and run (Arch / CachyOS; no sudo needed if the packages below are installed)

```sh
pacman -Q webkit2gtk-4.1 gtk3 libayatana-appindicator librsvg openssl     # all must be present
source ~/.cargo/env
cd apps/desktop && scripts/build-linux.sh          # -> out/current/Atlas_0.1.0_amd64.AppImage and .deb (+ SHA256SUMS); the previous AppImage moves to out/previous/
./out/current/Atlas_0.1.0_amd64.AppImage            # or: ./target/release/atlas-desktop
```

You need a Secret Service keystore (KDE Wallet or GNOME Keyring) running; the sign-in page asks for the server address, e-mail, password, a notes folder and the autostart choice.
**Do not point it at a production server you have not backed up** (the notes folder is synced, both ways); use a test server first. The app data lives in `~/.local/share/app.atlas.desktop/` (override with `ATLAS_DESKTOP_DATA_DIR`).

## Tests

```sh
cd apps/web && npx vitest run --project desktop-core           # core, adapter, simulation (also part of verify.sh)
cd apps/desktop && cargo test -p atlas-desktop-native           # ATLAS_KILL_RUNS=100 for the kill -9 test
cargo clippy --workspace --all-targets -- -D warnings && cargo audit
scripts/build-linux.sh e2e && node e2e/run.mjs target/debug/atlas-desktop   # real app, throwaway DB atlas_desktop_<hex> (needs the Postgres container and services/api/.venv)
node e2e/updater-test.mjs                                       # throwaway signing key, local server, ~10 minutes
```
