# Current Task

- Task ID: M9-08
- Status: DONE
- Depends on: M9-01…M9-07 (`DONE`)

## Goal
Release checklist + known limitations (docs/ROADMAP.md M9-08): a release document that is **labelled
by actual completeness** — a checklist of what must be true before a release, an honest known-limitations
list, and the release-readiness table (REQ-001…015) filled with real results. It must NOT claim
production-readiness while milestone gates remain open (M5/M6 calendar accounts, M8 device/mobile work).

## Plan
1. Read `docs/ROADMAP.md` (milestone status + every open/blocked task), `docs/ACCEPTANCE.md` (all gates +
   the "Release Readiness (M9)" table which is still all `NOT RUN`), `docs/RISKS.md`, `docs/SECURITY.md`,
   `docs/USER_GUIDE.md`/`docs/OPERATOR_GUIDE.md` (§12 "what is not delivered"), `docs/PRODUCT_SPEC.md`
   (REQ-001…015 and their definitions), `docs/DEPENDENCIES.md`, and `docs/CHANGELOG.md`.
2. Produce a **release document** (e.g. `docs/RELEASE.md`): a pre-release checklist (build/tests/security/
   backup/restore/upgrade/docs all green), a **known-limitations** list consolidated from the docs and
   risks, and a **release label** reflecting reality (e.g. "not production-ready: calendar + mobile
   pending"). Include the operator caveats recorded earlier (e.g. the Compose env-forwarding gap for
   `VAPID_*`/`GOOGLE_*`/`MICROSOFT_*`/`ALLOWED_HOSTS`/`EXPORT_DIR`/`CHANGE_RETENTION_DAYS`).
3. Fill the **"Release Readiness (M9)"** table in `docs/ACCEPTANCE.md`: each REQ-001…015 with an honest
   `PASS` / `PARTIAL` / `NOT RUN` and evidence, citing the milestone that delivered it — do NOT mark a
   requirement `PASS` when its delivery is blocked/incomplete.
4. Update `docs/CHANGELOG.md` with a release entry labelled by actual completeness (and/or a version
   heading), and ensure `README.md`'s status line points at the release doc.
5. Keep it consistent with `ROADMAP.md`/`ACCEPTANCE.md` (no competing truth). Do NOT start or claim the
   blocked work (M5-00/03/04/05/07/09, M6, M8-04/06/07/08).

## Acceptance
- A release checklist + known-limitations document exists, consistent with the roadmap and acceptance
  records, and **labelled by actual completeness** (explicitly not production-ready while gates are open).
- The `ACCEPTANCE.md` "Release Readiness (M9)" table is filled per REQ-001…015 with honest
  PASS/PARTIAL/NOT RUN + evidence; no requirement is overstated.
- Every known limitation (incl. the blocked milestones/tasks and the Compose env-forwarding caveat) is
  listed with its impact.
- `README.md`/`CHANGELOG.md` are consistent with the release label.
- No code/test changes required; `./scripts/verify.sh` still passes.

## Implementation
Produced **`docs/RELEASE.md`** — the release label (**`0.1.0-pre` — development snapshot · NOT
production-ready**), the pre-release checklist (§3, every item citing the evidence recorded in
`ACCEPTANCE.md`), the consolidated known-limitations list (§5), the "blocked on external resources" list
(§6) and "how to verify" (§7). Filled the **"Release Readiness (M9)"** table in `docs/ACCEPTANCE.md` per
REQ-001…015 with honest verdicts + delivering milestone, and added an **M9-08** acceptance section with
its own evidence table. Added a **`## [0.1.0-pre]`** release heading + an `Unreleased` entry to
`docs/CHANGELOG.md`; pointed `README.md`'s status at `docs/RELEASE.md`; set the `M9-08` row to `DONE`
with a verification paragraph and refreshed `ROADMAP.md`'s "Immediate Next Tasks"; linked the release
document from `OPERATOR_GUIDE.md` §12/§13. This is a docs/assessment task — **no code, migration,
dependency or test changed** — and it does **not** start or claim the blocked M5/M6/M8 work.

## Evidence
- Baseline (2026-10-27): full suite `969 passed`; frontend `268 passed`; browser E2E `7 passed`
  (separate command); `./scripts/verify.sh` → PASS; `pip-audit`/`npm audit` → 0 findings.
- `./scripts/verify.sh` re-run 2026-10-27 after the doc changes → `verification: PASS`
  (backend `969 passed`; frontend `268 passed`).
- Release Readiness verdicts: **9 `PASS`** (REQ-001/002/003/004/005/006/013/014/015),
  **3 `PARTIAL`** (REQ-010 cross-device, REQ-011 notifications, REQ-012 OS-agnostic),
  **3 `NOT RUN`** (REQ-007/008/009 calendar). Evidence + delivering milestones in `docs/ACCEPTANCE.md`.
- Files: added `docs/RELEASE.md`; changed `docs/ACCEPTANCE.md`, `docs/ROADMAP.md`, `docs/CHANGELOG.md`,
  `README.md`, `docs/OPERATOR_GUIDE.md`, `project/CURRENT_TASK.md`.

## Limitations / blocked
- The release is **not production-ready** and this document does not change that. The blocked work is
  recorded, not started: **M5-00** (real Google/Microsoft accounts — **AR-001**) and the dependent
  **M5-03/04/05/07/09**; **M6** (all of it); **M8-04/06/07/08** (real devices + a live push service);
  real (non-mocked) browser push delivery; and a literal two-device convergence run.
- `REQ-007/008/009` are `NOT RUN`; `REQ-010/011/012` are `PARTIAL` (mechanism-only / pipeline-only /
  Linux-only evidence). The Compose env-forwarding gap is documented as an operator caveat, **not fixed**
  (changing `deploy/docker-compose.yml` was out of scope). `scripts/verify.sh` does not run the browser
  E2E suite (a separate command). No `atlas` database or real data was touched.
