# Atlas — Release Checklist, Known Limitations and Release Label

**Status:** Active (Milestone 9, task M9-08)
**Last updated:** 2026-11-13 (sections 1-2 only; section 3 onwards still reflect 2026-10-27, see open item 6)
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
| 1 | **MU close-out:** real-stack browser E2E (`e2e-real`) green in CI; re-score the release table | `ROADMAP.md` MU, `ACCEPTANCE.md` | CI run |
| 2 | **SYNC-11c/11d and SYNC-12 release gate:** shell on one engine (partial), real-device matrix, backup/restore with devices attached, USER_GUIDE/OPERATIONS | `ROADMAP.md` SYNC | owner's devices |
| 3 | **Release workflow on the real server:** the in-app updater and the first real update have not run on the live server | `DEPLOYMENT.md` 12, REL-01 | owner's server |
| 4 | **A-07:** decide the supported Python version | `DECISIONS.md` | owner decision |
| 5 | **M5-12 manual `.ics` import** (kept by the owner) | `ROADMAP.md` Later | small build |
| 6 | **Rewrite the checklist below** from the current evidence (it still reflects 2026-10-27) | this file | docs |
| 7 | **Windows desktop:** not built or tested (R-36); either build it or state "Linux and Android only" in the notes | `ROADMAP.md` SYNC-09 | decision |

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

## 3. Pre-release checklist

The **buildable** release gates are green. Each item cites the command/evidence recorded in
[`ACCEPTANCE.md`](ACCEPTANCE.md); the release label in §1 reflects the items **not** green.

| # | Gate | Result | Evidence (cited) |
|---|---|---|---|
| 1 | **Build / lint / types** (backend `ruff check` + `ruff format --check` + `mypy`; frontend `eslint` + `tsc` + `vite build`) | `PASS` | `./scripts/verify.sh`; M9-06/M9-07 sections; frontend `npm run build` clean |
| 2 | **Tests — backend** | `PASS` | full suite **969 passed** (582 unit + integration) against PostgreSQL `atlas_test` (`ACCEPTANCE.md` M9-05/M9-06) |
| 3 | **Tests — frontend** | `PASS` | **268 passed** (`vitest`) — `ACCEPTANCE.md` M9-03/M9-05 |
| 4 | **Tests — browser E2E** (separate command `npm run e2e`) | `PASS` | **7 passed** (Chromium: M7 failure modes + M8-02 push consent) — `ACCEPTANCE.md` M8-02/M7 gate |
| 5 | **Security — advisories** | `PASS` | `pip-audit` → 0 advisories over 91 packages; `npm audit` → 0 over 370; CI gate fails on a finding (M9-04) |
| 6 | **Security — threat-model review** | `PASS` | M9-05 control-by-control review; one gap (F1, SPA security headers/CSP) found and **fixed & live-confirmed** in M9-06; residual risks recorded (`SECURITY.md`, `RISKS.md`) |
| 7 | **Backup (both stores)** | `PASS` | `atlas-backup` captures a consistent PostgreSQL dump **and** the Markdown archive with a checksummed manifest (M9-01/ADR-0041) |
| 8 | **Restore (demonstrated)** | `PASS` | executed restore drill — restored notes byte-identical and DB rows/schema identical to source; tampered/partial sets fail (M9-02) |
| 9 | **Upgrade + rollback (demonstrated)** | `PASS` | upgrade from a prior revision to head (data preserved, schema = models, app healthy) and rollback by downgrade **and** by backup restore (M9-06) |
| 10 | **Data portability** | `PASS` | versioned full export of notes (real `.md`) + tasks + projects + metadata, via `GET /api/export` and the `atlas-export` CLI (M9-03/ADR-0042) |
| 11 | **Dependency + licence inventory** | `PASS` | complete inventory of runtime/dev deps with licences (M0-08/M1-10; `DEPENDENCIES.md`; M9-04) |
| 12 | **Documentation** | `PASS` | user guide + operator guide (M9-07) and this release document (M9-08), reconciled with the code and the milestone evidence |
| 13 | **Clean install reproduces from docs** | `PASS` (recorded) | M1 gate (`docker compose up --build` → healthy) and `OPERATOR_GUIDE.md` §3; a *fresh-operator* run is not performed here — see known limitations |
| 14 | **No unresolved critical/high security finding** | `PASS` | M9-04 scan clean; M9-05 review found no critical/high defect (F1 was Low) |

**Gates that are NOT green (so a *production* release is not declared):**

| # | Gate | Result | Reason |
|---|---|---|---|
| A | Google Calendar account + event sync | `NOT RUN` | M5-00 `BLOCKED` (AR-001); M5-03 `BACKLOG` |
| B | Microsoft Outlook account + event sync | `NOT RUN` | M5-00 `BLOCKED` (AR-001); M5-04 `BACKLOG` |
| C | Unified calendar view | `NOT RUN` | M5-05/M5-07 `BACKLOG` |
| D | Bidirectional calendar editing | `NOT RUN` | M6 entirely `BACKLOG` |
| E | Notifications verified on real devices/desktop matrix | `NOT RUN` | M8-04/06/07/08 `BACKLOG` (need hardware + push service) |
| F | Literal multi-device convergence | `NOT RUN` | M7 gate verified the mechanism + browser E2E, not two physical devices |

Per `AGENTS.md` §5 ("if a criterion cannot be verified, record it as unverified — never silently
waive it"), items A–F are recorded as unverified/blocked, not waived.

---

## 4. Release Readiness (REQ-001…015) — summary

The canonical, evidenced table is in [`ACCEPTANCE.md`](ACCEPTANCE.md) §"Release Readiness (M9)".
Summary of verdicts (PASS = fully delivered and realistically verified; PARTIAL = delivered with a
material completeness/evidence gap; NOT RUN = not delivered):

| Verdict | Requirements |
|---|---|
| `PASS` | REQ-001, REQ-002, REQ-003, REQ-004, REQ-013, REQ-014, REQ-015 |
| `PARTIAL` | REQ-005 (tasks — capability delivered in the API; the UI can only capture and complete, ADR-0043), REQ-006 (projects — no Projects UI), REQ-010 (cross-device — mechanism + mocked E2E, no two-device run), REQ-011 (notifications — pipeline delivered; real/mobile delivery `NOT RUN`), REQ-012 (OS-agnostic — web client verified on Linux; mobile clients and desktop matrix `NOT RUN`) |
| `NOT RUN` | REQ-007 (Google Calendar), REQ-008 (Microsoft Outlook), REQ-009 (calendar consolidation) — all blocked on real provider accounts (AR-001) |

*Note 2026-11-04:* CI evidence now exists: the first GitHub Actions runs passed `backend` (pytest 4293, pip-audit clean), `e2e-real` (76 of 76), `containers` and `hygiene`, and `frontend` except its dev-dependency `npm audit` gate (R-61, owner decision). The verdicts in this table are **not** re-scored here; that needs owner review (`ACCEPTANCE.md` P0-4).

A **release is labelled by its weakest mandatory requirement**: with REQ-007/008/009 `NOT RUN` and
REQ-010/011/012 only `PARTIAL`, the release cannot be production-ready.

---

## 5. Consolidated known limitations

Each limitation lists its **impact** and where it is tracked. This consolidates
[`OPERATOR_GUIDE.md`](OPERATOR_GUIDE.md) §12, the per-task "Limitations" notes in
[`ACCEPTANCE.md`](ACCEPTANCE.md), and [`RISKS.md`](RISKS.md).

### 5.0 Personal alpha status (2026-11-03)

The notes/tasks/projects core was smoke-tested end to end on the current code in Docker Compose (fresh install, upgrade from
`b7d3e1a95c24` with data, HTTPS in front with Caddy, scheduled backups, a restore drill into a second empty stack):
`ACCEPTANCE.md` P0-1/P0-2/P0-3, install steps `DEPLOYMENT.md` section 11. For **one owner on one server** that is usable.
Still not done: `tailscale serve` and ACME were not run; no restore drill on the owner's real data; `e2e-real` ran on CI for the first time on 2026-11-04 (76 of 76 passed, P0-4; the CI workflow is still red on one dev-tooling `npm audit` finding, R-61); no browser other than headless Chromium on the same host; the rate-limit, redirect and HSTS edges of R-46; backup
sets are unencrypted and stay on the server's disk until copied off. Everything in 5.1 and below still applies.

### 5.1 Blocked on external resources (not defects)

1. **Calendar accounts and event views (REQ-007/008/009).** *Limitation:* no Google/Microsoft
   account-connection UI and no unified day/week/month view. What exists is the credential store
   (M5-01), the provider-neutral adapter contract (M5-02), the event projection + sync cursors
   (M5-06), a per-provider **sync-status** surface (M5-08) and periodic reconciliation (M5-10). *Impact:*
   a user cannot add a calendar or see external events; the `/calendar` page shows status only.
   *Blocked by:* **AR-001** — real Google/Microsoft test accounts; then M5-03/04/05/07/09.
2. **Bidirectional calendar sync (REQ-007/008).** *Limitation:* no external event create/edit,
   deletion propagation or conflict UI. *Impact:* Atlas-to-calendar writes are unavailable.
   *Blocked by:* M5 (above); M6 is entirely `BACKLOG`.
3. **Mobile apps and native push (REQ-011/012).** *Limitation:* no Android/iOS client, no native
   (FCM/APNs) push, and no Linux/Windows/macOS **desktop matrix** verification. *Impact:* reminders on
   a phone are not delivered; the web client is unverified on Windows/macOS. *Blocked by:* real
   devices + a push service (M8-04/06/07/08).
4. **Real (non-mocked) browser push delivery.** *Limitation:* the Web Push **pipeline** and consent
   states are tested (M8-02), but an actual notification delivered through a live push service to a
   real browser has not been observed. *Impact:* desktop delivery depends on the operator configuring
   **VAPID** keys; "it works end to end" is unverified. *Blocked by:* a live push service + VAPID keys.
5. **Literal multi-device convergence (REQ-010).** *Limitation:* cross-device sync is verified by the
   change-feed mechanism + Chromium E2E, but **no run with two physical devices** was performed and
   the E2E's API is mocked. *Impact:* convergence is proven by mechanism and tests, not by a live
   two-device field test.

### 5.2 UI surface gaps (delivered API-first)

6. **The web UI exposes a subset of the delivered capabilities.** *Limitation:*
   - **No Projects page** (create/manage a project is API-only); the Kanban **Board** and derived
     progress in Day/Week are the only project surfaces.
   - **Task capture is title-only**; editing a task's **due date, priority, recurrence, subtasks,
     project or linked notes** is API-only, as are the full **filtered list/search** and per-task
     **reminder override**. The **Tasks**, **Projects**, **Search** and **Settings** nav items open a
     placeholder screen.
   - **No in-app export button** (the export is `GET /api/export` or the `atlas-export` CLI).
   *Impact:* a non-technical user cannot perform these operations from the app. *Tracked:*
   [`USER_GUIDE.md`](USER_GUIDE.md) §5/"What you cannot do from the UI yet", §10.

### 5.3 Operator caveats

7. **Compose env-forwarding (fixed 2026-11-01, audit A-04).** The compose file now forwards every
   setting the application reads. `GOOGLE_*`/`MICROSOFT_*`/`FCM_*`/`EXPO_*` are deliberately not
   forwarded because no code reads them yet. *Not yet verified at runtime:* recreate the stack and check
   `docker compose … exec api env | sort` (see audit A-04).
8. **`TOKEN_ENCRYPTION_KEY` is load-bearing.** *Limitation:* stored OAuth credentials are encrypted
   with it; losing it makes them unreadable, and there is no automatic re-encryption job (a row is
   re-sealed only on its next write). *Impact:* it must be **backed up separately** from the database.
   *Tracked:* `OPERATOR_GUIDE.md` §4.2, `SECURITY.md` R-SEC-3.
9. **TLS/HTTPS termination is the operator's responsibility** and is not verified in this environment
   (`ACCEPTANCE.md` M9-05, T9 `NOT RUN`; `DEPLOYMENT.md` §8). The app assumes a reverse proxy
   terminates TLS.
10. **No dedicated job-queue dashboard.** Inspect the `jobs` table / worker logs directly
    (`OPERATOR_GUIDE.md` §9).
11. **Backup format/portability.** The dump is `pg_dump` **plain** format (restorable with `psql`); on
    a host without a PostgreSQL client the backup runs `pg_dump` inside the DB container via
    `docker exec` (`BACKUP_PG_DUMP_CONTAINER`). Backup integrity proves the set is *internally
    consistent*, and the M9-02 drill proves it **restores**, but the two were exercised against
    **scratch** targets, not a full in-place stack restart (`ACCEPTANCE.md` M9-02 limitation).

### 5.4 Data / schema notes

12. **`task_links` (task↔note) and `task_tags` exist but have no writer.** They are always empty and
    are not exported (recorded, not silently dropped; `ACCEPTANCE.md` M9-03).
13. **Manual edits to a recurring occurrence's due date are not re-synchronised with the series**
    (`ACCEPTANCE.md` M3-05 scope note).
14. **Task text search / `project_id` filter are unindexed scans** bounded by `limit`; fine at the
    intended personal scale, revisited with measured need (`RISKS.md` **R-20**, Accepted).

### 5.5 Residual security & continuous risks

15. **R-SEC-1** — the auth rate limiter keys on `request.client.host` and does not trust
    `X-Forwarded-For`, so behind a proxy it must be supplemented by the proxy's own rate limiting.
16. **R-SEC-2** — no account lockout and no MFA (available per ADR-0011 but not enabled by default).
17. **R-SEC-4** — the authorisation model is **single-user** (authenticated or not); roles/permissions
    are not modelled.
18. **R-21** — a registered Web Push `endpoint` is length/shape-bounded but **not** restricted to an
    `https` push-service host (accepted for the single-user model; revisit if multi-user is approved).
19. **Session TTL** defaults to 14 days (revocable on logout; configurable) — longer than a
    "short-session" posture implies.
20. **R-17 (dependency vulnerability)** stays **Open** because it is continuous: today's scans are
    clean (`pip-audit` 0/91, `npm audit` 0/370, M9-04) but a new advisory can appear at any time; the
    CI gate fails on an unresolved finding.
21. **T12 (work-account data-flow acknowledgement) is `NOT DELIVERED`** — the enforcing UI is M5-05
    (`ACCEPTANCE.md` M9-05).
22. **Licence inventory caveat.** Licences are recorded as reported by package metadata; they should be
    re-verified against upstream projects before a production release (`DEPENDENCIES.md`).

---

## 6. Remaining work is blocked on external resources

Nothing below can be completed in this environment; each item names the resource it needs.

| Blocked work | Needs |
|---|---|
| **M5-00** — validate Microsoft tenant + Google publishing mode with real accounts (AR-001) | Real Google + Microsoft (personal/M365) test accounts |
| **M5-03 / M5-04** — Google Calendar and Microsoft Graph adapters | AR-001 (real accounts) |
| **M5-05 / M5-07** — account/calendar selection UI and the unified day/week/month view | M5-03/04 |
| **M5-09** — provider change notifications → reconcile | M5-03/04 |
| **M6-01…M6-08** — bidirectional calendar editing (incl. real-account E2E) | M5 (AR-001) |
| **M8-04** — push delivery on real devices (FCM/APNs/relay) | Physical Android/iOS devices, a push service (and the Apple Developer Program for iOS) |
| **M8-06 / M8-07** — Android and iOS clients | Real devices + app toolchains |
| **M8-08** — desktop verification on Linux/Windows/macOS | Access to all three desktop platforms |
| **Real (non-mocked) browser push delivery** | A live push service + configured VAPID keys |
| **Literal two-device convergence run** | Two physical devices |

---

## 7. How to verify this snapshot

From the repository root (needs a reachable PostgreSQL pointed at by `TEST_DATABASE_URL`, default
`…:5432/atlas_test`):

```bash
./scripts/verify.sh        # backend lint/format/mypy + full pytest; frontend lint/typecheck/vitest
cd apps/web && npm run e2e # browser E2E (Chromium; separate from verify.sh; API mocked)
```

Expected: `verification: PASS` (backend **969 passed**, frontend **268 passed**) and `7 passed` for the
E2E. The exact commands and results behind every checklist item are in
[`ACCEPTANCE.md`](ACCEPTANCE.md). **`scripts/verify.sh` does not run the E2E suite** — it is a separate
command (`TESTING.md`).

---

## 8. Related documents

[`ROADMAP.md`](ROADMAP.md) (authoritative milestone/backlog status) ·
[`ACCEPTANCE.md`](ACCEPTANCE.md) (per-requirement readiness + all evidence) ·
[`PRODUCT_SPEC.md`](PRODUCT_SPEC.md) (REQ-001…015 and the release Definition of Done) ·
[`RISKS.md`](RISKS.md) · [`SECURITY.md`](SECURITY.md) · [`OPERATOR_GUIDE.md`](OPERATOR_GUIDE.md) §12 ·
[`USER_GUIDE.md`](USER_GUIDE.md) §1 · [`DEPENDENCIES.md`](DEPENDENCIES.md) ·
[`CHANGELOG.md`](CHANGELOG.md) · [`OPERATIONS.md`](OPERATIONS.md) · [`DEPLOYMENT.md`](DEPLOYMENT.md)
