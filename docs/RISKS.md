# Atlas — Risk Register

**Status:** Draft for approval (Milestone 0)
**Last updated:** 2026-10-27

Severity ∈ {High, Medium, Low}. Status ∈ {Open, Mitigating, Accepted, Closed}.
Every open risk has an owner-milestone and a mitigation. Risks are reviewed at each milestone gate.

---

## High severity

### R-01 — Microsoft tenant restrictions block calendar access
- **Severity/Likelihood:** High / Medium
- **Impact:** REQ-008 unmet for work accounts; OAuth app registration blocked by tenant policy.
- **Mitigation:** Validate OAuth + calendar access with a **real test account in M5 before
  building the adapter UI**. Provide documented app-registration steps for single-tenant and
  multi-tenant scenarios. Fall back to personal-account-only support if a tenant forbids
  delegated scopes, and document the limitation.
- **Owner milestone:** M5. **Status:** Open.

### R-02 — Calendar synchronisation conflicts or duplicates
- **Severity/Likelihood:** High / Medium
- **Impact:** Data loss or duplicate events across Google/Microsoft.
- **Mitigation:** Provider-specific adapters; explicit ownership; store provider version/etag;
  advance cursors only after commit; idempotent upserts keyed by provider event ID; conflict
  preservation instead of last-write-wins. Integration tests per `TESTING.md` §3.
- **Owner milestone:** M5–M6. **Status:** Open.

### R-03 — Markdown data loss
- **Severity/Likelihood:** High / Low
- **Impact:** Loss of user notes (irreplaceable).
- **Mitigation:** Atomic writes (temp + rename); revision/content-hash checks; conflict copies
  instead of overwrite; soft-delete to a recoverable location; automated file backups. No
  silent last-write-wins.
- **Owner milestone:** M2. **Status:** Open.

### R-04 — Mobile push limitations / platform cost
- **Severity/Likelihood:** High / Medium
- **Impact:** Reminders unreliable, or Apple membership cost surprises the user.
- **Mitigation:** Validate on physical devices in M8; document iOS Apple Developer requirement
  up front (ADR-0007); handle invalid tokens, receipts and retries; never promise instant
  delivery. Present alternatives (PWA/desktop, email fallback) if push is unavailable.
- **Owner milestone:** M8. **Status:** Open.

### R-05 — Background-job library maintenance (Procrastinate)
- **Severity/Likelihood:** High / Medium
- **Impact:** Chosen queue becomes unmaintained; sync/reminders at risk.
- **Mitigation:** Hide the queue behind the `jobs` module interface; keep schema generic;
  documented fallback to APScheduler + SQLAlchemy job store or a `SKIP LOCKED` queue
  (ADR-0005). Re-evaluate at M1.
- **Owner milestone:** M1. **Status:** Mitigating.

### R-06 — Excessive architecture complexity / scope creep
- **Severity/Likelihood:** High / Medium
- **Impact:** Project stalls; maintenance burden exceeds benefit.
- **Mitigation:** Modular monolith, few services; milestone gates; excluded-feature list in
  PRODUCT_SPEC §4.2; scope changes require a documented decision.
- **Owner milestone:** Continuous. **Status:** Mitigating.

### R-07 — Offline/concurrent edit conflicts
- **Severity/Likelihood:** High / Medium
- **Impact:** Divergent device state or lost edits.
- **Mitigation:** Revision-aware mutations; durable client-side pending queue; idempotency keys;
  tombstones; conflict states surfaced in UI. Tested in M7.
- **Owner milestone:** M7. **Status:** Open.

### R-08 — Backup restoration failure
- **Severity/Likelihood:** High / Low
- **Impact:** Unrecoverable loss despite backups existing.
- **Mitigation:** Back up **both** PostgreSQL and the Markdown directory; automated integrity
  check; a **tested** restore procedure executed in M9 (demonstrated, not documented only).
- **Owner milestone:** M9. **Status:** Open.

### R-09 — Workplace data-policy violation
- **Severity/Likelihood:** High / Low
- **Impact:** Corporate policy breach by storing work calendar/task data on a personal server.
- **Mitigation:** Document data flows and dependencies; require explicit user acknowledgement
  before connecting a work account; never bypass tenant security policy (ADR-0006).
- **Owner milestone:** M5. **Status:** Open.

### R-10 — AI-generated regressions
- **Severity/Likelihood:** High / Medium
- **Impact:** Subtle bugs merged because generated code "looks right".
- **Mitigation:** Small changes; automated unit/integration/E2E tests; no milestone passes
  without evidence; adversarial review of diffs.
- **Owner milestone:** Continuous. **Status:** Mitigating.

---

## Medium severity

### R-11 — External provider API changes
- **Severity/Likelihood:** Medium / Medium
- **Impact:** Adapter breakage after provider updates.
- **Mitigation:** Isolate provider code behind adapters; pin client library versions; contract
  tests against sandbox/test accounts; keep adapters small.
- **Owner milestone:** M5+. **Status:** Open.

### R-12 — Licensing incompatibility
- **Severity/Likelihood:** Medium / Low
- **Impact:** A dependency's licence forbids the intended commercial/personal use.
- **Mitigation:** Maintain a dependency inventory; check licence before adding; record in
  DECISIONS; avoid copyleft libraries that would restrict distribution. Audit in M9.
- **Owner milestone:** M1 (inventory), M9 (audit). **Status:** Open.

### R-13 — Google OAuth refresh-token expiry (Testing mode)
- **Severity/Likelihood:** Medium / High
- **Impact:** Calendar sync stops after ~7 days; user must re-authenticate repeatedly.
- **Mitigation:** Publish the OAuth app to **Production** (unverified) for personal use; verify
  real refresh-token lifetime with a test account in M5; document the trade-off (unverified
  screen / 100-user cap for sensitive scopes). See ADR-0008.
- **Owner milestone:** M5. **Status:** Open.

### R-14 — Time-zone and recurrence correctness
- **Severity/Likelihood:** Medium / High
- **Impact:** Wrong due dates, missed occurrences, DST bugs.
- **Mitigation:** Store UTC + IANA zone; RRULE-based recurrence via a maintained library;
  explicit DST and occurrence tests before release.
- **Owner milestone:** M3. **Status:** Open.

### R-15 — Notification duplication or missed reminders
- **Severity/Likelihood:** Medium / Medium
- **Impact:** User loses trust in reminders.
- **Mitigation:** Durable reminder state; idempotent delivery attempts; cancel on entity change;
  record failures; test worker restart behavior.
- **Owner milestone:** M8. **Status:** Open.

### R-16 — Accidental public exposure
- **Severity/Likelihood:** Medium / Low
- **Impact:** Private notes/tasks/calendar exposed to the internet.
- **Mitigation:** Only `web`/`api` exposed via reverse proxy; DB/worker private; HTTPS required;
  documented reverse-proxy config; no unauthenticated endpoints even in single-user mode.
- **Owner milestone:** M1. **Status:** Open.

### R-17 — Dependency vulnerability
- **Severity/Likelihood:** Medium / Medium
- **Impact:** Exploitable flaw in a pinned dependency.
- **Mitigation:** Automated dependency scanning in CI; pinned, reviewed dependencies; respond
  to advisories; never suppress findings to green CI.
- **Reviewed (M9-04, 2026-10-27):** both real scans were run and are **clean** — `pip-audit` → 0
  advisories over 91 packages; `npm audit` → 0 advisories over 370 packages (all severities 0). No
  finding of any severity exists, so none was accepted or suppressed. The gate is enforced in
  `.github/workflows/ci.yml` and fails the build on an unresolved finding (see `ACCEPTANCE.md` M9-04).
  Status stays **Open** because the risk is continuous (a new advisory can appear at any time).
- **Owner milestone:** Continuous. **Status:** Open.

---

## Low severity

### R-18 — PostgreSQL full-text search limits at scale
- **Severity/Likelihood:** Low / Low
- **Mitigation:** FTS is sufficient at household scale; revisit only with measured need.
- **Owner milestone:** M2. **Status:** Accepted.

### R-19 — Docker availability on the user's server
- **Severity/Likelihood:** Low / Low
- **Mitigation:** Document prerequisites and a Compose-based install; no Docker-in-Docker or
  Kubernetes dependency.
- **Owner milestone:** M1. **Status:** Accepted.

### R-20 — Task text search is an unindexed substring scan
- **Severity/Likelihood:** Low / Low
- **Description:** `GET /api/tasks?q=…` matches with an escaped `LIKE '%…%'` over `title`/
  `description` and `project_id` has no index yet, so both scan the user's rows and the listing is
  capped at `limit` (default 200).
- **Mitigation:** Fine at the intended personal scale (ADR-0018); the response is bounded, the
  term is length-bounded and parameterised, and the filters rely on the existing `user_id`/
  `status`/`priority`/`due_at` indexes. Revisit with measured need (a `tsvector` column + GIN
  index for search, an index for `project_id`) — the `project_id` index belongs to M4. M4-02 added
  the project-tasks listing on the same access path (per user, per project, bound by `limit`) and
  deliberately did **not** add the index: the statement is an index scan on `tasks.user_id` plus a
  filter, no measured need exists, and every schema change costs a migration (ADR-0021).
- **Owner milestone:** M3. **Status:** Accepted.

### R-21 — Web Push destination endpoint is not scheme/host-constrained
- **Severity/Likelihood:** Low / Low
- **Description:** A registered push destination (`notification_devices.endpoint`) is validated for
  length and shape (`atlas/notifications/registry.py`) but not restricted to an `https` push-service
  host, and the delivery path targets that URL directly (pywebpush). Raised by the M9-05 security
  review; no exploitable impact exists in the delivered single-user deployment.
- **Impact:** In a **multi-user** deployment with an attacker able to register a destination, the
  send would fetch an attacker-chosen URL (a blind-request/SSRF-shaped surface). Today the registrant
  is the only account (single-user), so any effect is self-directed.
- **Mitigation:** Destinations are strictly user-scoped (one account cannot register or target
  another's), and only the user's own active devices are ever sent to. Revisit with a scheme/host
  allow-list (e.g. `https` push-service hosts, or a per-provider allow-list) **if multi-user is ever
  approved** (`DECISIONS.md`); recorded here so it is not silently forgotten.
- **Owner milestone:** M8. **Status:** Accepted (M9-05).

### R-22 — Backend-heavy, interface-light delivery
- **Severity/Likelihood:** High / High (realised — found by the 2026-11-01 function audit)
- **Description:** Tasks were accepted on API tests, so the product accumulated endpoints, tests and
  documentation faster than usable screens. Tasks/Projects/Search/Settings are placeholders and the
  task list can only capture and complete; the owner reports the app as not useful.
- **Impact:** Green test suite and `DONE` roadmap status misrepresent what the owner can do; time
  spent on features nobody can reach.
- **Mitigation:** ADR-0043 — done means a browser journey passes against the real API; milestone MU
  (usable core) precedes further backend/calendar work; the release table is scored on user-reachable
  behaviour; journey tests run in CI (MU-07).
- **Progress:** MU-00 (harness) and MU-01 (task detail, J1/J2) delivered 2026-11-02. Open sub-risk from
  MU-01: task edits from the UI are online-only (idempotency key + `base_revision`, conflict shown); they
  are not yet routed through the offline queue (M7-03), so an edit made while offline fails visibly
  instead of queueing. Address when MU-08/M8 touch offline UX.
- **Owner milestone:** MU. **Status:** Mitigating.

---

## Review log

| Date | Milestone | Change |
|---|---|---|
| 2026-10-20 | M0 | Initial register created; R-05 and R-13 added from M0 research. |
| 2026-10-26 | M3-08 | R-20 added (task search/project filter scan; bounded by `limit`). |
| 2026-10-26 | M4-02 | R-20 reviewed (project-tasks listing on the same path; `project_id` index still deferred, no measured need). |
| 2026-10-27 | M9-04 | R-17 reviewed: `pip-audit` (91 pkgs) and `npm audit` (370 pkgs, prod+dev) both clean — 0 advisories at every severity. No finding accepted or suppressed; CI gate confirmed by inspection + local positive controls. |
| 2026-10-27 | M9-05 | Security review (threat model vs implementation). R-21 added (push endpoint not scheme/host-constrained; accepted for the single-user model). F1 (SPA missing security headers/CSP) found and fixed in `apps/web/nginx.conf`; R-SEC-1/2/4 re-confirmed, R-SEC-3 resolved. Detail in `docs/SECURITY.md` §"Milestone 9 security review". |
| 2026-11-01 | Audit | Function audit: R-22 added (backend-heavy, interface-light); ADR-0043 re-prioritises to a usable core. |
| 2026-11-02 | MU-03 | R-22 progress: Tasks page delivered (filters, sort, saved filters, bulk actions; journey passes). Sub-risks: client-side sort covers only the first 500 matches (R-20, page shows a notice); bulk actions are sequential, non-atomic and online-only. |
| 2026-11-02 | MU-02 | R-22 progress: Projects UI delivered (J3 passes in a browser); project mutations are online-only like task mutations. |
| 2026-11-02 | MU-01 | R-22 progress: task detail/editing delivered (J1, J2 pass in a browser). Sub-risk recorded: UI task mutations are online-only (not via the offline queue). |
