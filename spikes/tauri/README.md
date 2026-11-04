# SYNC-07 Tauri 2 spike (throwaway)

Evidence for ADR-0055 (Tauri 2 desktop shell, Electron fallback). **Not product code, not part of any workspace**: `apps/web`
(`npm run lint`, `npm run typecheck`, `vitest`) and `./scripts/verify.sh` never look here (they only read `apps/web` and
`packages/sync-core`; CI jobs have `working-directory: apps/web` / `services/api`). Results and the verdict live in
`docs/SYNC_PROTOCOL.md` ("Tauri spike: results"), the backlog row in `docs/ROADMAP.md` (SYNC-07). Raw outputs of the Linux run are in
`results/` (JSON, plus three screenshot pairs).

## Layout

| Path | What |
|---|---|
| `headless/` (`atlas-spike-core`) | Rust library used by the app and the headless checks: `db` (rusqlite, WAL, migrations, "apply page + cursor" transaction), `notes` (confined paths, atomic write, scan), `keystore` (`keyring` crate, Secret Service). `spike-headless` is the CLI for S2/S3/S4 |
| `src-tauri/` | The Tauri 2 app: commands for SQLite, notes folder, keystore, API proxy with the bearer attached in Rust, notification; plugins fs, dialog, notification, updater, single-instance; per-window capabilities (`capabilities/`) and `build.rs` app manifest (every command needs a permission) |
| `ui/` | Harness page (`index.html`, `src/harness.js`, `src/sync.js` = real `packages/sync-core` round trip, bundled by esbuild), `scenario.js` (the S1 scenario run in WebKitGTK **and** Chromium), `atlas-driver.js`, `probe.js` |
| `scripts/` | `stack.mjs` (throwaway DB `atlas_spike_<random>` + API + static/proxy server + owner), `seed.mjs`, `run-atlas.sh` (S1), `run-suite.sh` (S2/S4/S5/S9 suites), `chromium.mjs` (baseline), `footprint.mjs` (S8), `build-bundles.sh`, `updater-test.sh` (S6), `update-server.mjs` |

## Prerequisites (Linux, this machine: CachyOS)

System packages (already present, nothing was installed with sudo): `webkit2gtk-4.1 libsoup3 openssl librsvg gtk3 libayatana-appindicator base-devel`.
User-level (installed for the spike, see `docs/DEPENDENCIES.md`): Rust via rustup (`~/.cargo`, `~/.rustup`), `cargo-audit`,
`cargo-license`, `tauri-driver` (unused: no `WebKitWebDriver` binary is installed), npm dev packages in `node_modules/`.
A display is needed (the user's Wayland/Xwayland session was used; windows open briefly). WebKitGTK 2.54 here needs
`WEBKIT_DISABLE_DMABUF_RENDERER=1` (the scripts export it), otherwise the window dies with `Gdk Error 71 (Protocol error)`.

## Commands (from `spikes/tauri`, with `~/.cargo/bin` on `PATH`)

```sh
npm install                                              # @tauri-apps/cli, esbuild, playwright-core
export SPIKE_OUT=/tmp/spike-out WORK=/tmp/spike-work     # reports, bundles/keys (never publish what is under WORK)
(cd ../../apps/web && ./node_modules/.bin/vite build --outDir /tmp/spike-web-dist --emptyOutDir)   # read-only use of apps/web
node scripts/stack.mjs up /tmp/spike-web-dist            # throwaway DB atlas_spike_*, API, UI server; prints ports
node scripts/seed.mjs                                    # tasks, projects, notes incl. a 5 000-line note
npx esbuild ui/src/harness.js --bundle --format=iife --outfile=ui/harness.bundle.js
cargo build -p atlas-spike --release --features custom-protocol
scripts/run-atlas.sh desktop; scripts/run-atlas.sh phone; node scripts/chromium.mjs desktop; node scripts/chromium.mjs phone   # S1
scripts/run-suite.sh ipc|fsscope|keystore|fetch|sync|notify|probe,sw|embedded                                                   # S2,S3,S4,S5,S9
cargo build -p atlas-spike-core --release && target/release/spike-headless sqlite-bench|sqlite-kill|notes-watch|keyring <dir>   # S2,S3,S4
node scripts/footprint.mjs 30                                                                                                  # S8
scripts/build-bundles.sh && scripts/updater-test.sh      # S6, S8 (AppImage, deb); test key pair generated under $WORK/keys
node scripts/stack.mjs down                              # drops the throwaway database
```

`run-suite.sh embedded` needs the variant that embeds the built web UI: `npx tauri build --no-bundle -c '{"build":{"frontendDist":"/tmp/spike-web-dist"}}'`, copy `target/release/atlas-spike` aside, then run it with `SPIKE_SUITE=embedded` (rebuild normally afterwards: it overwrites the release binary).

`run-suite.sh fsscope` expects `$SPIKE_NOTES` (default `/tmp/atlas-spike-run/notes`) with `a.md`, `sub/b.md`, `.hidden.md`, a symlink
`link-to-outside.md` and a symlinked directory `linkdir`, plus `../outside-secret.txt` and `../notes-sibling/x.md` (see results for
the expected refusals). The `sync` and `fetch` suites sign a device in against the throwaway stack and leave a token for service
`atlas-spike-sync07` in the Secret Service: remove it with `secret-tool clear service atlas-spike-sync07`.

## Uninstall

`rustup self uninstall` (removes `~/.cargo` and `~/.rustup`; nothing else was changed, `--no-modify-path` was used);
`rm -rf spikes/tauri/target spikes/tauri/node_modules`; `rm -rf ~/.local/share/app.atlas.spike`.
