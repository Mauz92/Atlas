# Atlas — Dependency and Licence Inventory

**Status:** Active (Milestone 9)
**Last updated:** 2026-11-09 (httpx runtime; `@atlas/reminder-core` has no dependencies; ntfy 2.37.2 `Apache-2.0 OR GPL-2.0` is an operator-run optional service used only for loopback verification, not a dependency)

Every dependency must permit the intended personal and professional use (REQ-003). Additions are
reviewed before introduction and recorded here with purpose and licence. Licence identifiers are
as reported by the package metadata; verify against the upstream project before a release.

## Runtime — backend (`services/api`)

| Package | Purpose | Licence | Notes |
|---|---|---|---|
| fastapi | HTTP API framework | MIT | |
| uvicorn[standard] | ASGI server | BSD-3-Clause | |
| pydantic | Validation / settings models | MIT | |
| pydantic-settings | Env-based configuration | MIT | |
| email-validator | Email address validation (Pydantic) | CC0-1.0 | |
| sqlalchemy | ORM / Core | MIT | 2.x async |
| alembic | Schema migrations | MIT | |
| psycopg[binary] | PostgreSQL driver (sync + async) | LGPL-3.0 | Used as an unmodified library dependency; no distribution obligation triggered |
| argon2-cffi | Password hashing (Argon2id) | MIT | |
| itsdangerous | Signed tokens (CSRF) | BSD-3-Clause | |
| python-multipart | Form parsing | Apache-2.0 | |
| python-dateutil | RFC 5545 RRULE recurrence engine (M3-05) | BSD-3-Clause OR Apache-2.0 | Dual-licensed; imported as `dateutil.rrule.rrulestr` (3.0.0 no longer exports top-level `FREQ`). ADR-0015 |
| pywebpush | Web Push (VAPID) desktop delivery (M8-02) | MPL-2.0 | Maintained `web-push-libs` project; signs and sends the push request. Bound `>=2.5,<3.0`. Used behind the `Notifier` abstraction; no custom crypto. ADR-0039 |
| httpx | The sync-hint gateway adapter (M8-04e): one bounded `POST` per hint, redirects off, no body read | BSD-3-Clause | **Moved from dev to runtime on 2026-11-09** (`>=0.27,<1.0`, installed 0.28.1). Already vetted as a dev dependency; maintained (encode/httpx), no known advisory in the `pip-audit` of this inventory. No new package enters the image, only an existing one moves. |
| icalendar | RFC 5545 parsing of ICS feeds (M5-11, ADR-0072) | BSD-2-Clause | Checked 2026-11-10: package metadata `BSD-2-Clause`, installed 7.3.0, bound `>=6.1,<8.0`; maintained by the Plone/collective project (releases through 2026); pure Python, no network or native code; requires only `python-dateutil` and `tzdata`. Parsing only: recurrence stays on `python-dateutil` (no `recurring-ical-events`, LGPL-3.0). No paid service. `pip-audit` NOT RUN for this addition in this environment (CI runs it). |
| tzdata | IANA zone database for `zoneinfo` on slim images (calendar time zones) | Apache-2.0 | Already installed transitively by `icalendar`; declared directly (`>=2024.1`, installed 2026.5) so the container never depends on a system zone database. |
| cryptography | Authenticated encryption (AES-256-GCM) for OAuth tokens at rest (M5-01) | Apache-2.0 OR BSD-3-Clause | Maintained `pyca` project; used via the high-level `AESGCM`/`HKDF` APIs (no custom crypto). Bound `>=50,<51` — the floor clears the advisories `pip-audit` reports against earlier 4x wheels. ADR-0027 |

## Runtime — frontend (`apps/web`)

| Package | Purpose | Licence | Notes |
|---|---|---|---|
| react, react-dom | UI runtime | MIT | |
| react-router-dom | Client routing | MIT | |
| vite | Build tool / dev server | MIT | |
| typescript | Type checking | Apache-2.0 | |
| codemirror (+ @codemirror/*) | Markdown source editor; `@codemirror/autocomplete` for `[[` note completion (MU-06, ADR-0048; was already a transitive dependency) | MIT | Lazy-loaded on the notes route; `@codemirror/language` (`syntaxTree`) for Live preview (UX-06, ADR-0056): already installed as a dependency of `@codemirror/lang-markdown`, now declared directly in `package.json` at the installed version (no new code, no new package in the lockfile) |
| marked | Markdown → HTML rendering | MIT | |
| dompurify | HTML sanitisation of rendered notes | MPL-2.0 OR Apache-2.0 | Untrusted content (SECURITY T3/T6) |

## Considered and not adopted

| Package | Purpose considered | Licence / maintenance (package metadata, checked 2026-11-03) | Decision |
|---|---|---|---|
| recurring-ical-events | expanding ICS recurrences | LGPL-3.0 | Rejected: copyleft; `python-dateutil` already does the job (ADR-0072) |
| Google API client / Microsoft Graph SDK | provider calls | Apache-2.0 / MIT | Rejected: heavy, hide retry and error behaviour; plain `httpx` against documented REST (ADR-0071) |
| merge3 1.0.0 (Breezy) | three-way text merge for note sync (SYNC-04) | GPL-2.0-or-later; active (release 2026-10-25) | Rejected: copyleft is incompatible with the intended distribution (AGENTS.md 14) |
| diff-match-patch 20241021 | character-level diff/patch | Apache-2.0; last release 2024-10 | Rejected for merging: its patch application is fuzzy by design; a merge must be exact or refused |
| three-merge 0.1.1 | merge of two strings against a base | MIT; last release 2020-07 (unmaintained) | Rejected: stale, a wrapper over diff-match-patch |
| `git merge-file` | three-way file merge | GPL-2.0, external binary | Rejected: not in the API image; subprocess per request |

The note merge (`atlas/notes/merge.py`, ADR-0060) is therefore an in-repo implementation on the Python standard library
(`difflib`, PSF licence), with property tests; no dependency was added for SYNC-04.

## Vendored assets (no package)

| Asset | Where | Licence | Notes |
|---|---|---|---|
| Lucide icons (46 shapes: sun, moon, inbox, calendar-days, calendar-range, calendar, square-check, square-kanban, folder-kanban, file-text, search, settings, bell, chevron-right, chevron-down, x, menu, panel-left, cloud, cloud-off, refresh-cw, triangle-alert, keyboard, log-out; UX-03 added ellipsis, check, chevron-left, flag, sunrise, folder-input, trash-2, list-checks, corner-down-right; UX-04 added clock, globe, tag, repeat, link, circle-dot; UX-05 added panel-right, file-plus, folder, folder-plus, chevrons-down-up, layout-template; UX-10 added plus for the capture button; SYNC-11 added undo-2, arrow-left-right, monitor-smartphone, shield-alert, activity, upload, download, git-merge, transcribed from the Lucide SVG source and checked visually in the SYNC-11 screenshots) | `apps/web/src/components/Icon.tsx` (inline SVG, 24 px viewBox, 1.75 stroke, `currentColor`) | ISC | UX-02/UX-03, ADR-0051 §3, `UX_AUDIT.md` §3.3. No npm icon package and no network request. Shapes follow the Lucide 0.4xx-series SVG source (upstream names kept); they were transcribed into the file and checked visually in the UX-02 screenshots, not generated by a tool, so compare with upstream when adding or updating one. The notice below is reproduced in the file header. |

Lucide licence notice (required by ISC):

```
ISC License

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT).
All other copyright (c) for Lucide are held by Lucide Contributors 2022.

Permission to use, copy, modify, and/or distribute this software for any purpose with or without
fee is hereby granted, provided that the above copyright notice and this permission notice appear
in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS
SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE
AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT,
NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

## Development / CI

| Package | Purpose | Licence |
|---|---|---|
| pytest, pytest-asyncio | Test runner | MIT / Apache-2.0 |
| httpx | Test HTTP client (also a runtime dependency since M8-04e, see the runtime table) | BSD-3-Clause |
| ruff | Lint + format | MIT |
| mypy | Static type checking | MIT |
| pip-audit | Python advisory scanning (CI) | Apache-2.0 |
| npm audit | JS advisory scanning (CI, built in) | — |
| @axe-core/playwright (+ axe-core) | Automated accessibility checks in the real-stack suite (MU-08, ADR-0050) | MPL-2.0 | Dev-only, never bundled. Deque's `axe-core` engine; version 4.14.0 (published 2026-10-15). MPL-2.0 is file-level copyleft and imposes nothing on Atlas code because the package is not modified or distributed. Peer: `playwright-core`. |
| openapi-typescript | Generate TS types from OpenAPI | MIT |
| vitest, jsdom, @testing-library/react | Frontend unit tests | MIT |
| fake-indexeddb | In-memory IndexedDB for frontend tests (exercises the real offline-queue storage path under jsdom, which has no IndexedDB) | MIT |
| eslint, typescript-eslint | Frontend linting | MIT / BSD-2-Clause |
| @vitejs/plugin-react | Vite React plugin | MIT |
| @playwright/test | End-to-end (browser) tests (M7-06): real-Chromium failure-mode E2E. Also downloads a pinned **Chromium / "Chrome for Testing"** browser build (open-source Chromium, BSD-3-Clause) via `npx playwright install chromium`. Test-only — never ships in the app; no telemetry or paid service. | Apache-2.0 |

## External services / platform costs (not software dependencies)

| Item | Cost | Notes |
|---|---|---|
| Google Calendar API | Free (quota-limited) | ADR-0009 |
| Microsoft Graph | Free (throttled) | ADR-0009 |
| Firebase Cloud Messaging (Android push) | Free, but needs a Google account/Firebase project | ADR-0007; **rejected by default for Atlas (ADR-0068 D8, PROPOSED 2026-11-04)**: local alarms + an optional self-hosted UnifiedPush hint instead |
| ntfy (self-hosted UnifiedPush gateway) | Operator-run container; free; public `ntfy.sh` is a third-party service and not recommended | optional, off by default (ADR-0068) |
| APNs / iOS delivery | **Apple Developer Program (annual fee)** | ADR-0007, PRODUCT_SPEC §3.1 |
| PostgreSQL, Docker, reverse proxy | Self-hosted (existing infra) | |

## Decisions and rejections

- **Procrastinate** (Postgres task queue, MIT) — considered but not adopted in M1; upstream is
  seeking maintainers (RISKS R-05). A minimal in-repo `SKIP LOCKED` queue is used instead, behind
  the same `jobs` interface, so the choice is reversible (ADR-0005).
- **`vitest` 5** and **`pytest` 9** adopted during the M1 security review to clear known
  advisories (see `docs/SECURITY.md` §11). Both audits (`npm audit`, `pip-audit`) run in CI; a
  finding must be fixed or explicitly justified, never suppressed to green the build.
- Anything under a licence that would restrict self-hosted personal/commercial use, or that adds a
  mandatory paid service, is rejected.

## Vulnerability scan (M9-04, 2026-10-27)

Real advisory scans were run against the installed dependency trees on 2026-10-27. Both are **clean**:
there is **no finding of any severity** to upgrade, pin or accept, and nothing was suppressed.

**Backend — `pip-audit` 2.10.1 (`services/api/.venv`, Python 3.14.8):**

```
$ cd services/api && .venv/bin/pip-audit --progress-spinner off
Name      Skip Reason
--------- ------------------------------------------------------------------------
atlas-api Dependency not found on PyPI and could not be audited: atlas-api (0.1.0)

No known vulnerabilities found          # exit 0
```

- **91** distributions audited, **0** advisories — every runtime pin (`fastapi` 0.154.0,
  `cryptography` 50.0.2, `sqlalchemy` 2.0.55, `psycopg` 3.3.6, `pywebpush` 2.5.0, `python-dateutil`
  3.0.0, `argon2-cffi` 25.1.0, …) and the dev/CI toolchain (`pytest` 9.1.1, `ruff` 0.17.1, `mypy`
  1.20.2, `pip-audit` 2.10.1, `httpx` 0.28.1).
- `atlas-api` is the **local, unreleased workspace package**, not a published dependency, so
  `pip-audit` reports it as *skipped* rather than as a finding — expected, **not** a suppression.

**Frontend — `npm audit` (Node 26.11.1 / npm 12.2.1, `package-lock.json` v3):**

```
$ cd apps/web
$ npm audit --include=dev              # found 0 vulnerabilities   (exit 0)
$ npm audit --omit=dev                 # found 0 vulnerabilities   (exit 0; production only)
$ npm audit --audit-level=moderate     # found 0 vulnerabilities   (exit 0; the CI gate)
```

- **370** locked packages (32 production, 338 development, plus optional/peer) — **0** advisories at
  every severity (info / low / moderate / high / critical all `0`).

**Nothing is hidden.** There is no `--ignore-vuln`, no laxer `--audit-level`, and no `.npmrc` /
`--omit` exclusion in the repository that would mask a result; the only audited-skip is the local
`atlas-api` package above.

**CI gate (`.github/workflows/ci.yml`).** The `backend` job runs `pip-audit --progress-spinner off`
(non-zero exit on **any** advisory) and the `frontend` job runs `npm audit --audit-level=moderate`
(non-zero exit on **moderate/high/critical**). This already satisfies — and is stricter than — the
M9-04 acceptance "no unresolved critical/high". Confirmed by inspection of the workflow; GitHub
Actions itself could not be exercised in this environment (see `ACCEPTANCE.md` M9-04). The gate's
**failure semantics** were proven locally with controlled positive controls (scratch only, no repo
change): `pip-audit -r` on a file pinned to `urllib3==1.26.4` → exit 1 ("Found 20 known
vulnerabilities"), and `npm audit --audit-level=high` on a scratch project pinned to `lodash@4.17.20`
→ exit 1 ("1 high severity vulnerability").

## Verification

- Licences checked at introduction. Advisory scanning runs in CI on every push/PR and fails the build
  on an unresolved finding.
- M9-04 scan (2026-10-27): `pip-audit` → 0 advisories over 91 packages; `npm audit` → 0 advisories
  over 370 packages. Exact commands and evidence in `ACCEPTANCE.md` M9-04; the recurring risk is
  tracked as `RISKS.md` R-17.


## packages/sync-core (SYNC-08, 2026-11-04)

No runtime or new dev dependency. Tests, type check and lint use the web app's existing `vitest`, `typescript` and `eslint` (all
already in `apps/web/package.json`). `node:` modules are used only under `sim/` (test code).

## SYNC-07 Tauri spike (`spikes/tauri/`, 2026-11-04): toolchain, crates, tools

**Throwaway evidence code, not a product dependency set.** Nothing here is in `apps/web`, `services/api` or `packages/*`, and none of it ships. It becomes a
product dependency only when SYNC-09 adopts it (and then moves into this inventory's runtime sections). Versions are the resolved ones in `spikes/tauri/Cargo.lock` and
`package-lock.json`; release dates from the crates.io API on 2026-11-04. Advisory check: `cargo audit` 0 vulnerabilities (577 crates), 8 warnings (see `RISKS.md` R-36);
`npm audit` 0. Licences by `cargo license` / package metadata; **no GPL or AGPL anywhere in the Linux build graph.**

**Installed on the owner's machine (owner-approved 2026-11-04, user-level, no sudo):** Rust stable 1.99.1 via `rustup` (installer script read first, downloaded from `https://sh.rustup.rs`
which fetches `https://static.rust-lang.org/rustup`; `--profile minimal --no-modify-path`, so no shell profile was changed) in `~/.cargo` and `~/.rustup`; `cargo install --locked`:
`tauri-driver` (unused: no `WebKitWebDriver` on the machine), `cargo-audit`, `cargo-license`; their build output is in `~/.cargo/registry`. Uninstall: `rustup self uninstall`
(removes both directories) and `rm -rf ~/.local/share/app.atlas.spike` (webview profile of the spike app). `tauri build` downloads bundling tools on first use into `~/.cache/tauri`:
`AppRun-x86_64` (tauri-apps/binary-releases), `linuxdeploy-x86_64.AppImage` (pinned build `07333c6`), `linuxdeploy-plugin-appimage` (**the `continuous` tag: an unpinned download; pin it before any release build**).

| Package | Used | Released | Purpose in the spike | Licence | Notes |
|---|---|---|---|---|---|
| `tauri` | 2.12.5 | 2026-10-21 | shell | Apache-2.0 OR MIT | 2.x pinned; `3.0.0-alpha.*` exist and are not used |
| `tauri-build` | 2.7.4 | 2026-10-21 | build script, app manifest (per-command permissions) | Apache-2.0 OR MIT | |
| `wry` / `tao` | 0.57.1 / 0.37.2 | 2026-10-23 | webview / windowing (transitive) | Apache-2.0 OR MIT / Apache-2.0 | |
| `tauri-plugin-fs` | 2.7.1 | 2026-10-14 | scoped file access (`watch` feature compiled, not exercised) | Apache-2.0 OR MIT | |
| `tauri-plugin-dialog` | 2.8.4 | 2026-10-28 | native folder picker (compiled, not exercised) | Apache-2.0 OR MIT | |
| `tauri-plugin-notification` | 2.8.0 | 2026-10-28 | local notification; replaces `window.Notification` | Apache-2.0 OR MIT | desktop has no scheduling |
| `tauri-plugin-updater` | 2.14.1 | 2026-10-28 | signed updates (minisign via `minisign-verify` 0.3.0, MIT) | Apache-2.0 OR MIT | AppImage only on Linux |
| `tauri-plugin-single-instance` | 2.5.5 | 2026-10-28 | single instance | Apache-2.0 OR MIT | |
| `tauri-plugin-sql` | 2.6.0 | 2026-10-14 | **evaluated, not used**: read source; cannot be linked with `rusqlite` | Apache-2.0 OR MIT | |
| `rusqlite` (+ `libsqlite3-sys` 0.35.0, bundled SQLite 3.50.2) | 0.37.0 | 2025-07-06 | local database behind own commands | MIT (SQLite: public domain) | 0.41.1 is current (2026-10-28) |
| `keyring` (+ `dbus-secret-service` 4.1.0) | 3.6.3 | 2025-07-27 | OS keystore (Secret Service) | MIT OR Apache-2.0 | 4.2.0 exists (2026-08-29); no file fallback |
| `notify` | 8.2.1 | 2026-10-25 | file watcher (inotify) | CC0-1.0 | `9.0.0-rc.*` not used |
| `reqwest` | 0.12.28 | 2025-12-22 | HTTPS client in Rust, `rustls-tls` (bundled Mozilla roots: `webpki-roots` CDLA-Permissive-2.0) | MIT OR Apache-2.0 | 0.13.5 exists; trust-store decision in SYNC-09 |
| `serde`, `serde_json` | 1.0.229, 1.0.154 | 2026-07-18, 2026-10-11 | | MIT OR Apache-2.0 | |
| `webkit2gtk`, `gtk`, `cairo-rs` | 2.0.2, 0.18.2, 0.18.5 | 2025-12-16, 2024-12-09, 2023-12-30 | WebKitGTK snapshot (Linux only, test helper) | MIT | gtk-rs 0.18 line is Tauri's own; `glib` 0.18.5 RUSTSEC-2024-0429 |
| `@tauri-apps/cli` | 2.12.4 | 2026-10-21 | `tauri build` | Apache-2.0 OR MIT | npm dev |
| `esbuild` | 0.25.12 | (0.28.2 current) | bundles the harness and `packages/sync-core` | MIT | npm dev; its post-install is blocked by npm's allowScripts and not needed |
| `playwright-core` | 1.64.1 | 2026-11-04 | drives system Chromium for the baseline | Apache-2.0 | npm dev; no browser downloaded |

Licence summary of the 577 crates: ~351 `Apache-2.0 OR MIT`, 127 `MIT`, 24 `Apache-2.0 OR MIT OR Zlib`, 18 `Unicode-3.0`, 11 `MIT OR Unlicense`, **5 `MPL-2.0`** (`cssparser`,
`cssparser-macros`, `dtoa-short`, `option-ext`, `selectors`: file-level copyleft, unmodified use, no distribution obligation beyond keeping the notices), 2 `CDLA-Permissive-2.0`
(`webpki-roots`, `webpki-root-certs`), 2 `Apache-2.0 OR LGPL-2.1-or-later OR MIT` (`r-efi`: LGPL is an alternative, MIT chosen); the rest are BSD/ISC/Zlib/CC0 variants. The Windows graph was checked later (below); the Android graph was **not** (`SYNC_PROTOCOL.md` 13.4). External services: none for the Linux runs (the local update server and API never left `127.0.0.1`).

### SYNC-07 Windows runner (`.github/workflows/windows-spike.yml`, 2026-11-04): actions, tools, Windows graph

Manual only (`workflow_dispatch`), throwaway, no repository secrets. **GitHub Actions pinned to commit SHAs** (each tag resolved with `gh api repos/<owner>/<repo>/git/ref/tags/<tag>`, annotated tags dereferenced; newer
releases exist and were deliberately not taken: they were not needed and the pins are re-verified per release, see `SECURITY.md` supply chain):

| Action | Pin | Released | Licence | Purpose |
|---|---|---|---|---|
| `actions/checkout` | `v4.2.2` = `11bd71901bbe5b1630ceea73d27597364c9af683` | 2024-10 | MIT | source (same major as `ci.yml`, which still uses the floating `@v4`) |
| `actions/setup-node` | `v4.4.0` = `49933ea5288caeca8642d1e84afbd3f7d6820020` | 2025-04 | MIT | Node 22 |
| `Swatinem/rust-cache` | `v2.8.0` = `98c8021b550208e191a6a3145459bfc9fb29c4c0` | 2025-06-25 | LGPL-3.0 (an Action used as a service in a workflow; it is not linked into or shipped with any build output) | caches `~/.cargo` and `spikes/tauri/target` (the 13 minute cold build becomes about 3 minutes warm) |
| `actions/upload-artifact` | `v4.6.2` = `ea165f8d65b6e75b540449e92b4886f43607fa02` | 2025-03 | MIT | installers, results |

Rust is installed with the runner's own `rustup` (`rustup toolchain install stable --profile minimal --target x86_64-pc-windows-msvc`; 1.99.1 on the first runs), not a third-party action. The runner image
(`windows-latest` = `win25-vs2026`, image 20261030.294.1, Windows Server 2025) provides MSVC, Node and WebView2 (runtime 156.0.4314.50). `tauri build` downloads NSIS and the WebView2 bootstrapper
tooling from GitHub/Microsoft at build time (unpinned downloads in the Tauri CLI; fine for a spike, pin before any release build). `cargo-audit` 0.22.2 and `cargo-license` 0.7.0 are
`cargo install --locked` on an `ubuntu-latest` job (they work from the lockfile and `cargo metadata --filter-platform x86_64-pc-windows-msvc`, no Windows host needed). One crate change in the spike:
`keyring` gets the `windows-native` feature on `cfg(windows)` (without a platform feature `keyring` 3 falls back to a **mock** store, which would have faked the S4 result).

**Windows graph (`cargo license --filter-platform x86_64-pc-windows-msvc`, 329 packages):** `Apache-2.0 OR MIT` 203, `MIT` 63, `Unicode-3.0` 18, `MIT OR Unlicense` 10, `Apache-2.0 OR MIT OR Zlib` 6,
**`MPL-2.0` 5** (the same five as Linux), `Apache-2.0` 2 (`tao`, `sync_wrapper`), `BSD-3-Clause`, `ISC`, `Zlib`, `CC0-1.0` (`notify`), `CDLA-Permissive-2.0` (`webpki-roots`) and the rest permissive; **no GPL, AGPL or LGPL in the
Windows graph.** New Windows-only crates over Linux: `windows` 0.6x family, `windows-sys` (two versions), `webview2-com*` (MIT), `tauri-winres`, `embed-resource`, `winreg`, `tauri-winrt-notification`, `static_vcruntime`,
`windows-registry`, `windows-version`, `windows-threading`. `cargo audit` on the lockfile: **0 vulnerabilities**; 8 warnings (7 unmaintained, 1 unsound) which are the same eight as Linux (`proc-macro-error`, `zbus_names` x2,
`zvariant` x2, `zvariant_derive` x2 (RUSTSEC-2026-0370/0371/0372), `glib` RUSTSEC-2024-0429); **none of those crates is in the Windows dependency graph** (checked: absent from the 329-package license list), so the
Windows target has no advisory warning. Raw outputs: artifact `atlas-spike-windows-supply-chain` of the runs in `ACCEPTANCE.md` SYNC-07.

## M8-04 device reminders and sync hints (design, 2026-11-04; nothing added to any lockfile yet)

Inventory of what the design would introduce. Licences and versions marked **[VERIFIED]** were read from crates.io metadata or a project page on 2026-11-04; everything else must be checked at the pinned tag before adoption (AGENTS.md 14).

| Item | Role | Licence / maintenance | Notes |
|---|---|---|---|
| `tauri-plugin-notification` 2.8.0 | local notifications; Android scheduling via AlarmManager | `Apache-2.0 OR MIT`, updated 2026-10-28 **[VERIFIED]** | already used in the spike; Rust 1.90+; manifest declares `POST_NOTIFICATIONS`, `RECEIVE_BOOT_COMPLETED`, `WAKE_LOCK`, not the exact-alarm permissions **[VERIFIED from source]** |
| `tauri-plugin-autostart` 2.7.0 | start at login (Windows `HKCU` Run, Linux autostart entry) | `Apache-2.0 OR MIT`, 2026-10-01 **[VERIFIED]** | AppImage path behaviour **[UNVERIFIED]**; Tauri tray (`tray-icon` feature) and `libayatana-appindicator` already in the spike graph |
| ntfy server | optional self-hosted UnifiedPush gateway (container run by the operator) | dual `Apache-2.0` and `GPL-2.0` **[VERIFIED from the project page]**; release version/date not read | a separate service, not linked into Atlas; operating cost is the owner's (AGENTS.md 14) |
| ntfy Android app (distributor) | UnifiedPush distributor on the phone | licence **[UNVERIFIED]** (separate repository `ntfy-android`); F-Droid and Play builds exist | the Play build may use FCM on its own side for the public instance; self-hosted use does not require it **[UNVERIFIED]** |
| UnifiedPush Android connector library | registration, receiving and decrypting messages in the Android shell | licence and current version **[UNVERIFIED]** | RFC 8291/8292 based per unifiedpush.org; may need a small Kotlin plugin |
| `httpx` (already in `services/api/pyproject.toml`, `>=0.27,<1.0`) | outbound hint POST; `pywebpush` (already present, M8-02) if the connector needs RFC 8291 encryption | no new Python package expected | no provider SDK |
| Firebase / FCM | **not adopted** | — | rejected by default, ADR-0068 D8 |

No telemetry, analytics or paid service is introduced. The Android permissions `USE_EXACT_ALARM`, `SCHEDULE_EXACT_ALARM`, `POST_NOTIFICATIONS` and `RECEIVE_BOOT_COMPLETED` are platform declarations, not dependencies; Google Play's exact-alarm policy applies only if the app is ever published there.

## SYNC-09 desktop client (`apps/desktop`, `packages/desktop-core`, 2026-11-10; Linux phase 1)

`packages/desktop-core` has **no dependencies** (it imports the two in-repo cores by relative path). `apps/desktop` is a separate Cargo workspace (`native` + `src-tauri`) and a separate npm package; none of it is in `apps/web`'s lockfile, `verify.sh` or CI. Versions are the locked ones (`apps/desktop/Cargo.lock`, 503 crates for the Linux graph, started from the spike's lock). Licence identifiers from `cargo license` on 2026-11-10.

| Crate / package | Purpose | Licence | Notes |
|---|---|---|---|
| `tauri` 2.12.5 (+ `tauri-build`) | The shell (window, IPC with per-command ACL, tray, bundling) | MIT OR Apache-2.0 | features `tray-icon`, `image-png`; same line as the spike (14 days old at the time); 2.x pinned, no alpha |
| `tauri-plugin-dialog` 2.8.4 | The native folder dialog, called from Rust only (no JS permission) | MIT OR Apache-2.0 | |
| `tauri-plugin-notification` 2.8.0 | Desktop notifications (`show`, called from Rust) | MIT OR Apache-2.0 | desktop implementation has no scheduling (S5): the app schedules |
| `tauri-plugin-single-instance` 2.5.5 | A second launch focuses the first | MIT OR Apache-2.0 | |
| `tauri-plugin-autostart` 2.7.0 (+ `auto-launch` 0.6.0) | Opt-in start at login (`~/.config/autostart/*.desktop`; uses `$APPIMAGE` for an AppImage) | MIT OR Apache-2.0 / MIT | off by default, asked at first run (ADR-0068 Q2) |
| `tauri-plugin-updater` 2.14.1 | Signed updates | MIT OR Apache-2.0 | **optional Cargo feature `updater`, in no default build** (SYNC-09e); verified in SYNC-07 S6 |
| `rusqlite` 0.41.1 (bundled `libsqlite3-sys` 0.39.1) | The local database | MIT / SQLite is public domain | **0.37 was replaced**: `cargo audit` (advisory DB of 2026-11-10) reported RUSTSEC-2026-0459 against `libsqlite3-sys` < 0.39 (bundled C SQLite CVE-2026-119375, medium); 0.41 fixes it; adds `sqlite-wasm-rs` to the lock for wasm targets only (not built) |
| `notify` 8.2.1 | inotify / ReadDirectoryChangesW watcher | CC0-1.0 | `Access` events are dropped (S3) |
| `sha2` 0.10.9 | SHA-256 of note bytes (the server's `content_hash`) | MIT OR Apache-2.0 | RustCrypto; no custom crypto |
| `keyring` 3.6.3 | OS keystore (Secret Service; Credential Manager on Windows) | MIT OR Apache-2.0 | `sync-secret-service` + `crypto-rust`; no file fallback; Windows needs `windows-native` (a mock store is used silently otherwise: set explicitly) |
| `reqwest` 0.12.28 (`rustls-tls-native-roots`, `json`) | The only HTTP client; token attached here | MIT OR Apache-2.0 | trusts the platform certificate store (R-60), not the bundled Mozilla roots; `rustls` 0.23.46, `rustls-native-certs` 0.8.5 (Apache-2.0 OR ISC OR MIT) |
| `tokio` 1.54.1, `serde` 1.0.229, `serde_json` 1.0.154 | Runtime for the client, (de)serialisation | MIT (OR Apache-2.0) | |
| `tempfile` 3.27.0 | dev-dependency of the Rust tests | MIT OR Apache-2.0 | |
| `@tauri-apps/cli` 2.12.4 | `tauri build` (dev tool, not shipped) | MIT OR Apache-2.0 | exact version, `package-lock.json` |
| `esbuild` 0.25.12 | Bundles the bridge and the sign-in page; bundles `sync-core` for the e2e second client (dev tool, not shipped) | MIT | exact version; its npm post-install is not run (the platform binary comes as an optional dependency) |

**Licence summary of the Linux graph (503 crates):** 333 `Apache-2.0 OR MIT`, 134 `MIT`, 25 `Apache-2.0 OR MIT OR Zlib`, 18 `Unicode-3.0`, 12 `MIT OR Unlicense`, 5 `MPL-2.0` (`cssparser`, `cssparser-macros`, `dtoa-short`, `option-ext`, `selectors`: file-level copyleft, unmodified use, as in the spike), 5 `ISC`, small numbers of BSD/Zlib/CC0 combinations, 2 `UNLICENSED` (our own two crates). **No GPL or AGPL.** `r-efi` lists `LGPL-2.1-or-later` only as one of three alternatives (`Apache-2.0 OR LGPL-2.1-or-later OR MIT`). Distribution: the AppImage bundles WebKitGTK and GTK from the build machine (LGPL-2.1+ system libraries, dynamically linked, unmodified); the `.deb` depends on the distribution's packages instead.

**Advisories (`cargo audit`, 2026-11-10): 0 vulnerabilities, 8 warnings** (unchanged from the spike, all transitive through the GTK/D-Bus stack and not called by Atlas code: `proc-macro-error` 1.0.4 unmaintained, `zbus_names` 3.0.0/4.3.5, `zvariant` 4.2.0/5.15.1, `zvariant_derive` 4.2.0/5.15.1 unmaintained, `glib` 0.18.5 unsound `VariantStrIter`). `npm audit` for `apps/desktop`: see ACCEPTANCE SYNC-09.

**Bundler tools (not packages; pinned by SHA-256 in `apps/desktop/packaging/bundler-tools.tsv`):** `AppRun-x86_64` (tauri-apps/binary-releases `apprun-old`), `linuxdeploy` AppImage (tauri-apps/binary-releases `linuxdeploy-07333c6`, MIT), `linuxdeploy-plugin-appimage` (linuxdeploy project `continuous` release: a moving URL, so only the checksum pins it, MIT). The plugin scripts for GTK and GStreamer are embedded in the pinned `@tauri-apps/cli`. `fetch-bundler-tools.sh` fails if a download does not match.

**Platform costs:** none new. A Windows code-signing certificate and any update hosting remain the owner's optional costs (above); a Linux AppImage/.deb needs no signing.

## SYNC-10 Android client (`apps/desktop/plugins/atlas-android`, 2026-11-12)

**Toolchain (installed in user space on the owner's PC, none of it in the repository):** Temurin OpenJDK 17.0.21 (GPLv2 with Classpath Exception; tarball sha256 `8b9b611d...e8711`), Android command-line tools 11076708 (zip sha256 `2d2d5085...e5e258`), Android SDK platform 35, build-tools 35.0.0, platform-tools 37.0.1 (adb), NDK 27.2.12479018 (Apache-2.0 / LLVM exceptions); the Android SDK licence terms were accepted on the owner's instruction (`sdkmanager --licenses`). Gradle comes from the generated project's wrapper (Apache-2.0).

| Dependency | Purpose | Licence | Notes |
|---|---|---|---|
| `tauri-plugin-atlas-android` (this repository) | Keystore token, alarms, delivery log, boot re-arm, status | UNLICENSED (project code) | Rust handle + Kotlin; depends only on `tauri` 2, `serde`, `serde_json` and, in Kotlin, AndroidX `core-ktx` 1.9.0 and `appcompat` 1.6.0 (Apache-2.0) |
| `reqwest` with `rustls-tls-webpki-roots` (Android only) | TLS with the bundled Mozilla roots (`webpki-roots`, CDLA-Permissive-2.0 / MPL data) | MIT OR Apache-2.0 | replaces `rustls-tls-native-roots` on Android; Linux and Windows are unchanged |
| `keyring` | now Linux-only (`cfg(target_os = "linux")`) besides the Windows entry; Android uses the plugin | MIT OR Apache-2.0 | |
| `tauri` features `tray-icon`, `tauri-plugin-dialog`, `-notification`, `-single-instance`, `-autostart`, `-updater` | desktop targets only (`cfg(not(any(android, ios)))`) | MIT OR Apache-2.0 | unchanged versions |

| `zip` 9.5.1 (`deflate`, Android only) | The notes export zip | MIT | already in the lock through Tauri; `zopfli` 0.8.4 added by the feature (Apache-2.0) |
| Jackson `databind`/`core` 2.22.4 (forced) | Tauri's Android runtime parses plugin arguments with it | Apache-2.0 | Tauri pulls 2.15.3 (15 advisories); forced in `patch-android.mjs`; OSV scan of the release classpath 2026-11-12: 2 of 80 artifacts affected before the override, 0 after (re-scan not run on 2.22.4 beyond the version query) |

The generated Android project pulls AndroidX `webkit` 1.14.0, `appcompat` 1.7.1, `activity-ktx` 1.10.1, Material 1.12.0, `lifecycle-process` 2.10.0 (Apache-2.0) and Kotlin; `cargo audit` on `Cargo.lock` (2026-11-13): 0 vulnerabilities, the same 8 warnings as the Linux graph; none of those crates (`zbus`, `zvariant`, `glib`, `proc-macro-error`) is in the Android target's graph (365 crates, checked with `cargo tree --target aarch64-linux-android`). The Gradle graph (80 artifacts) was queried against OSV on 2026-11-12 (only the public Maven coordinates were sent): Jackson only, fixed above. The spike's Android additions (SYNC-07) are not shipped.

