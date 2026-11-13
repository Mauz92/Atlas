# Atlas — Release Checklist, Known Limitations and Release Label

**Status:** Active (Milestone 9, task M9-08)
**Last updated:** 2026-11-13 
**Scope:** the pre-release checklist, the consolidated known-limitations list, and the release label
for the current state of Atlas. Per-requirement readiness (REQ-001…015) lives in
[`ACCEPTANCE.md`](ACCEPTANCE.md) §"Release Readiness (M9)"; milestone status is authoritative in
[`ROADMAP.md`](ROADMAP.md).

This document is deliberately blunt. Atlas is built milestone by milestone, and **several gates are
open because they need resources this environment does not have** (real Google/Microsoft accounts,
real mobile devices, a live push service). This document is **labelled by actual completeness**: it
does **not** claim production-readiness and it does **not** present blocked work as done.

---

## 1. Release label

> ## **`0.1.0` — first release, for private use (own devices, tailnet-only). Plan, 2026-11-13.**
> The tag is **not cut yet**: see the open list below. Until it is, the label is `0.1.0-pre`.

What 0.1.0 is: a self-hosted workspace of Markdown notes, tasks, projects and planning (REQ-004/005/006), cross-device sync and offline (REQ-010), reminders (REQ-011) on the web, the **Linux desktop app** and the **Android app** (a signed APK you build yourself), read-only calendars through **ICS links** (REQ-009), with security, backup/restore, export and in-app server updates (REQ-013/014/015).

What it is **not**: public (Atlas stays on the tailnet until the SEC-01 audit), Windows/macOS/iOS, Google or Microsoft **API** calendar sync and calendar writing (**deferred, ADR-0076**), push wake-up for Android, background sync that survives a reboot.

**Still open before the tag (nothing else blocks it):**

| # | Open item | Where | Needs |
|---|---|---|---|
| 1 | ~~MU close-out~~ **Done 2026-11-13:** `e2e-real` green in CI (run 43420687967); the release table re-score is proposed in `ACCEPTANCE.md` and awaits the owner's confirmation | `ROADMAP.md` MU | owner confirms the re-score |
| 2 | ~~SYNC-11c/12~~ **Done 2026-11-13** (11d moved to Later): shell on one engine, real-device matrix, restore with devices attached (`ACCEPTANCE.md` SYNC-12) | `ROADMAP.md` SYNC | done |
| 3 | **Release workflow on the real server:** the in-app updater and the first real update have not run on the live server | `DEPLOYMENT.md` 12, REL-01 | owner's server |
| 4 | ~~A-07 supported Python version~~ **Decided 2026-11-13 (ADR-0078): 3.13 runtime, 3.12 minimum** (owner can overturn) | `DECISIONS.md` | done |
| 5 | ~~M5-12 manual `.ics` import~~ **Done 2026-11-13** | `ACCEPTANCE.md` M5-12 | done |
| 6 | ~~Rewrite the checklist~~ **Done 2026-11-13** | this file | done |
| 7 | ~~Windows desktop~~ **Resolved 2026-11-13 (ADR-0077): 0.1.0 is Linux and Android only** (web app included); say so in the release notes | `DECISIONS.md` ADR-0077 | done |

**Not required for 0.1.0 (Later, `ROADMAP.md`):** Google/Microsoft API sync and writing (M5-00/03/04/09, M6), SEC-01 audit (required before any public exposure), UnifiedPush wake-up, iOS.

---

## 2. What is in / out of 0.1.0

| Area | State |
|---|---|
| Markdown notes, tasks, projects, planning | **In, verified** (M2-M4) |
| Cross-device sync + offline, conflict screens, devices list | **In, verified** (M7, SYNC-01…11; browser path on its own engine, R-54) |
| Reminders: web push, Linux desktop (resident), Android (exact alarms, keep-connected option) | **In, verified on Linux and one Android phone + emulator** |
| Linux desktop app (AppImage, .deb) | **In** (`ACCEPTANCE.md` SYNC-09; e2e 23/23) |
| Android app (signed APK, Keystore, export, shared folder) | **In** (`ACCEPTANCE.md` SYNC-10, `DONE` with recorded limitations) |
| Calendar: ICS links, unified Day/Week/Month/Agenda, read-only | **In, fixture-tested; a real Proton link UNVERIFIED** |
| Security, backup + restore, upgrade/rollback, export, server updater | **In** (updater not yet run on the live server) |
| Google/Microsoft calendar API sync, calendar writing | **Out, deferred (ADR-0076)** |
| Windows/macOS desktop, iOS | **Out** |
| Public exposure | **Out** until SEC-01 |

---

## 3. Pre-release checklist (refreshed 2026-11-13)

Each row cites evidence in [`ACCEPTANCE.md`](ACCEPTANCE.md) or a CI run. `PASS`, `FAIL`, `BLOCKED`, `NOT RUN` as defined in `TESTING.md` section 9.

| # | Gate | Result | Evidence |
|---|---|---|---|
| 1 | Backend lint, format, types, tests | `PASS` | `ruff check`, `ruff format --check`, `mypy` clean; **`pytest` 4770 passed, 14 skipped** (2026-11-13, real PostgreSQL); CI job "Backend" green (run 43420687967) |
| 2 | Frontend lint, types, tests, build | `PASS` | `eslint`, `tsc`, CSS scale check clean; **`vitest` 1567 passed**, 5 skipped; CI job "Frontend" green |
| 3 | Real-stack browser journeys (J1-J7, calendar incl. `.ics` import, axe in both themes at four widths) | `PASS` | `npm run test:e2e:real` locally; CI job "Real-stack journeys" green (run 43420687967) |
| 4 | Desktop and Android clients | `PASS` | Rust `cargo test` (native 24 + copy 4 + keystore 1 + durability 1) and clippy clean; Linux desktop e2e **23/23**; Android phone e2e **14/14**, Android 15 emulator, soaks of 45 and 180 min; CI "Android" workflow green (run 43419691993) |
| 5 | Security: dependency advisories | `PASS` | CI gates (`pip-audit`, `npm audit`, `cargo audit`: 0 vulnerabilities, 8 transitive Linux-only warnings); Android Gradle graph scanned with OSV (Jackson forced to 2.22.4) |
| 6 | Security: threat-model review | `PASS` with open items | `SECURITY.md` sections 15, 15a, 16, 16a reviewed against the code; SEC-01 independent audit is **not** done and is required before any public exposure |
| 7 | Backup of both stores | `PASS` | `atlas-backup` (PostgreSQL dump + Markdown archive, checksummed manifest; M9-01), scheduled in the app |
| 8 | Restore demonstrated | `PASS` | M9-02 drill (byte-identical notes, identical rows); clients stop on the restore screen and resume (Linux and Android e2e, `ACCEPTANCE.md` SYNC-12) |
| 9 | Upgrade and rollback demonstrated | `PASS` for the CLI path; `NOT RUN` for the in-app updater on the live server | M9-06; REL-01 dry run (run 43381705466); the first real update of the owner's server is still to do |
| 10 | Data portability | `PASS` | `GET /api/export`, `atlas-export` (M9-03); Android has its own **Export notes** |
| 11 | Release workflow | `PASS` (dry run) | `Release` workflow dry run green (run 43381705466): images, Linux desktop, checksums; not yet run for a real tag |
| 12 | Documentation matches the code | `PASS` with the known lag | USER_GUIDE, OPERATIONS, DEPLOYMENT, SECURITY, TESTING updated through 2026-11-13; sections 4-7 below are summaries |

---

## 4. Release readiness (REQ-001...015), 0.1.0 scope

The authoritative table is in `ACCEPTANCE.md` "Release Readiness (M9)"; the **proposed re-score of 2026-11-13** (awaiting the owner's confirmation) gives: `PASS` REQ-001/002/003/004/005/006/010/013/014/015, `PARTIAL` REQ-009 (ICS only, real exports untried), REQ-011 (real Web Push delivery unverified, iOS out) and REQ-012 (Windows/macOS/iOS out, ADR-0077), `DEFERRED` REQ-007/008 (ADR-0076).

## 5. Known limitations of 0.1.0 (consolidated)

- **Clients:** web (PWA), Linux desktop, Android. No Windows, macOS or iOS (ADR-0077).
- **Calendar:** read-only, through ICS links and `.ics` file imports; Google and Microsoft API sync and all calendar writing are deferred (ADR-0076). Imported files are not refreshed; replace them by hand. Real exports from Google, Outlook, Apple and Proton are untried.
- **Android:** notes are inside the app unless the owner opts into the shared folder; Export notes zips them. No push wake-up and no background sync after a reboot or after Android destroys the app (optional keep-connected service for the running case). Reboot re-arm verified on an emulator only; one phone vendor; no real CJK soft keyboard test (ADR-0075, `ACCEPTANCE.md` SYNC-10).
- **Linux desktop:** reminders fire only while the app runs (autostart and tray keep it resident); GNOME tray needs an extension.
- **Browser:** keeps its own offline queue engine (R-54); no IndexedDB offline mode (SYNC-11d, Later).
- **Notifications:** real Web Push delivery to a browser is unverified; exact local reminders are verified on Linux and Android.
- **Operations:** TLS with a publicly trusted certificate is required for the native clients; the in-app updater has not run on the live server; Atlas stays tailnet-only until the SEC-01 audit.
- **Open risks** are in `RISKS.md` (R-36 Windows install, R-54, R-73, R-82 to R-86, the calendar risks now deferred).

## 6. What remains before tagging 0.1.0

The list in section 1 is authoritative. In short: the owner confirms the release re-score, and the first in-app update runs on the owner's server (dry run first). Everything else is Later.

## 7. How to verify this snapshot

```sh
./scripts/verify.sh                                   # backend lint/format/types/tests + frontend lint/types/tests
cd apps/web && npm run test:e2e:real                  # real API + throwaway PostgreSQL
cd apps/desktop && cargo test -p atlas-desktop-native && scripts/build-linux.sh e2e && node e2e/run.mjs target/debug/atlas-desktop
cd apps/desktop && scripts/build-android.sh debug aarch64 && node e2e/android.mjs      # USB phone with debugging
```

## 8. Related documents

[`ROADMAP.md`](ROADMAP.md) (authoritative milestone/backlog status) ·
[`ACCEPTANCE.md`](ACCEPTANCE.md) (per-requirement readiness + all evidence) ·
[`PRODUCT_SPEC.md`](PRODUCT_SPEC.md) (REQ-001…015 and the release Definition of Done) ·
[`RISKS.md`](RISKS.md) · [`SECURITY.md`](SECURITY.md) · [`OPERATOR_GUIDE.md`](OPERATOR_GUIDE.md) §12 ·
[`USER_GUIDE.md`](USER_GUIDE.md) §1 · [`DEPENDENCIES.md`](DEPENDENCIES.md) ·
[`CHANGELOG.md`](CHANGELOG.md) · [`OPERATIONS.md`](OPERATIONS.md) · [`DEPLOYMENT.md`](DEPLOYMENT.md)
