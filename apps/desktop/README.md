# Atlas desktop and Android app (SYNC-09 phase 1: Linux; SYNC-10: Android)

A Tauri 2 shell around the Atlas web UI. Design and rules: `docs/DECISIONS.md` ADR-0069, `docs/ARCHITECTURE.md` section 8a, `docs/SECURITY.md` section 15.
It is **not** part of `scripts/verify.sh` or CI; the framework-neutral parts it uses (`packages/desktop-core`, the adapter test, the web bridge) are tested by `apps/web`'s vitest.

| Path | What |
|---|---|
| `native/` | Rust, no Tauri: `store.rs` (SQLite), `notes.rs` + `watch.rs` (confined folder, watcher), `keystore.rs`, `http.rs` (token attached here), `rules.rs`. `cargo test -p atlas-desktop-native` |
| `src-tauri/` | Tauri commands, tray, window, plugins; `capabilities/main.json` is the whole webview permission list; features `updater` and `e2e` (both off by default) |
| `plugins/atlas-android/` | Android only (ADR-0075): Rust handle + Kotlin plugin: Keystore-backed token, exact reminder alarms, delivery log, boot re-arm, status. No webview commands |
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

## Android (SYNC-10, ADR-0075)

The same shell, built for Android; `plugins/atlas-android` supplies what a phone has and a computer does not.

**Toolchain (user space, no sudo):** JDK 17 (Temurin), Android command-line tools, `platform-tools`, platform 35, build-tools 35.0.0, NDK 27.2.12479018, and the Rust targets `aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`. The defaults the scripts use are `~/.local/android/{jdk17,sdk}` (override with `JAVA_HOME`, `ANDROID_HOME`, `NDK_HOME`); exact versions and checksums are in `docs/SYNC_PROTOCOL.md` 13.4a. Accepting the Android SDK licences is the owner's decision (`sdkmanager --licenses`).

```sh
scripts/android-keystore.sh                 # once: creates keys/atlas-android.jks (your signing key; back it up, never commit it)
scripts/build-android.sh debug aarch64      # debug APK (inspectable WebView, loopback http allowed): src-tauri/gen/android/app/build/outputs/apk/universal/debug/
scripts/build-android.sh release aarch64    # signed release APK with the key above (use `all` for every ABI)
adb install -r <the apk>                    # USB debugging on; "Always allow from this computer"
node e2e/android.mjs                        # real phone against a throwaway API (see below)
```

`src-tauri/gen/android` is generated (gitignored); `scripts/patch-android.mjs` is the whole customisation: no backup, the keyboard resizes the page, `minSdk 26`, release signing.

**What is different on a phone:** the notes folder is `<app data>/notes` (private to the app, no dialog); reminders are `AlarmManager.setAlarmClock` alarms re-armed after a reboot; the token is an AES-GCM ciphertext under an Android Keystore key; there is no tray, autostart, updater or background sync (ADR-0075 D4, D7, D8). The server needs HTTPS with a publicly trusted certificate (a tailnet certificate works); cleartext HTTP is refused except loopback.

**The phone test** (`e2e/android.mjs`) needs one USB-connected phone with USB debugging, the debug APK, the Postgres container and `services/api/.venv`. It installs the app fresh, drives the real pages through the WebView's DevTools, and asks Android what happened (`dumpsys alarm`, `dumpsys notification`, the Keystore preferences). It creates and drops its own database `atlas_android_<hex>`, reaches the API over `adb reverse`, and clears the app's data at the end. `E2E_HOLD=1` keeps everything alive for debugging (remove `e2e/results/android-hold` to clean up); `E2E_SKIP_REMINDERS=1` skips the two slow reminder steps; `E2E_SKIP_EDITOR=1` skips the soft-keyboard editor step (the emulator's software rendering cannot run it); `E2E_REBOOT=1` adds a step that **reboots the phone** and needs you to unlock it once (proves the alarms are re-armed after a restart). `scripts/android-s5.sh`, `android-killtest.sh` and `android-cfg.sh` in `spikes/tauri/scripts` are the older spike probes.
