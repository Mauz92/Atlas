# Atlas — Risk Register

**Status:** Draft for approval (Milestone 0)
**Last updated:** 2026-10-20

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

---

## Review log

| Date | Milestone | Change |
|---|---|---|
| 2026-10-20 | M0 | Initial register created; R-05 and R-13 added from M0 research. |
