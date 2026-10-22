# Atlas — Acceptance Record

**Status:** Active (Milestone 0)
**Last updated:** 2026-10-20

Records verification evidence for milestone gates. A milestone is not complete until its criteria
are marked `PASS` here with evidence, or explicitly recorded as `BLOCKED`/`NOT RUN`.

Evidence vocabulary: `PASS`, `FAIL`, `BLOCKED`, `NOT RUN`.

---

## M0 — Discovery and Architecture

| Criterion | Result | Evidence |
|---|---|---|
| Core architecture documented | `PASS` | `ARCHITECTURE.md` drafted (components, ownership, flows) |
| Every important requirement has an implementation strategy | `PASS` | `PRODUCT_SPEC.md` §3, §5 |
| Unresolved technical risks visible | `PASS` | `RISKS.md` (R-01…R-19) |
| Dependency licences checked | `PASS` | Inventory in `docs/DEPENDENCIES.md` (M0-08) |
| No production features built prematurely | `PASS` | No application code exists; docs only |
| Repository skeleton + CI | `PASS` | Layout, per-area READMEs and `.github/workflows/ci.yml` authored (M0-07) |

**Gate:** architecture + backlog approved by product owner — **APPROVED 2026-10-20**.

---

## M1 — Foundation and Secure Deployment

Verified 2026-10-20 on Linux with Python 3.14, Node 26, PostgreSQL 18.6 and Docker 29.9.

| Criterion | Result | Evidence |
|---|---|---|
| Clean install starts from documented steps | `PASS` | `docker compose -p atlas -f deploy/docker-compose.yml up --build -d` → `db` healthy, `api` healthy, `worker` up, `web` up; web UI on :8081 returns HTTP 200 |
| Persistent data survives restart | `PASS` | `docker compose down` (volumes kept) then `up` → pre-restart account still logs in; `setup_required:false` |
| Unauthenticated users cannot access protected data | `PASS` | `pytest`: `test_me_requires_authentication` → 401; `test_csrf_required_for_authenticated_writes` → 403. Also verified live: `GET /api/auth/me` → 401 without a session |
| Migrations run reproducibly on a clean DB | `PASS` | `alembic upgrade head` on fresh PostgreSQL 18.6; `alembic check` → "No new upgrade operations detected"; container `api` runs `atlas-migrate` on start and creates the schema |
| No real secrets required in source control | `PASS` | `.env.example` placeholders only; `Settings.validate_for_runtime()` rejects placeholders when `ATLAS_ENV=production` |

**Test evidence (commands actually run):**

- `cd services/api && .venv/bin/python -m pytest -q` → `36 passed` (against a real PostgreSQL).
- `cd services/api && .venv/bin/ruff check . && ruff format --check .` → clean.
- `cd services/api && .venv/bin/mypy` → `Success: no issues found in 26 source files`.
- `cd apps/web && npm run lint && npm run typecheck && npm run test && npm run build` → clean;
  `vitest` 1 passed; Vite build produced `dist/`.
- Containerised end-to-end: signup via the web container (`POST /api/auth/setup` through nginx →
  api → db) → 201; `GET /api/auth/me` → 200 with session, → 401 without; `POST /api/auth/logout`
  → 204.
- Containerised worker: `noop` job enqueued inside the `api` container reached `status=succeeded`
  (attempts=1) by the `worker` container.

**Unverified:** a live GitHub Actions run — there is no remote to push to. Mitigation: the whole
workflow was executed locally with `nektos/act` (Docker) and every job passed:

- `hygiene` → docs present, no `.env` tracked, `docker compose config -q` OK.
- `backend` → ruff, `ruff format --check`, mypy, `pytest` (50 passed), `pip-audit`, OpenAPI export,
  artifact upload.
- `frontend` → artifact download, `npm ci`, API-type drift check, eslint, tsc, vitest,
  `npm audit` (0 vulnerabilities), production build.
- `containers` → all three images built via `docker compose build`.

The gate was also shown to be real: a deliberately failing test made the `backend` job exit
non-zero (`❌ Failure - Main Tests`), and the failure was reverted.

**Security baseline review (M1-11):** performed and recorded in `docs/SECURITY.md` §11. All
M1-applicable threat-model controls verified; four issues found and fixed (log redaction, login
timing enumeration, dependency advisories, production API docs), with residual risks R-SEC-1…4
recorded.

---

## M2 — Markdown Notes

Verified 2026-10-20 on Linux with Python 3.14, Node 26, PostgreSQL 18.6 and Docker 29.9.

| Criterion | Result | Evidence |
|---|---|---|
| Notes are actual `.md` files | `PASS` | `test_create_note_writes_a_real_markdown_file`; verified inside the container volume (`cat /data/atlas/notes/Inbox/Hello.md`) |
| Files readable in an ordinary editor | `PASS` | Content is written verbatim as UTF-8; no proprietary wrapper or metadata is added to the file |
| Unicode / special characters preserved | `PASS` | `test_unicode_and_special_characters_survive`, `test_unicode_content_round_trips_through_the_api` |
| Path traversal prevented | `PASS` | `tests/unit/test_note_paths.py` (traversal, absolute, reserved dir, symlink escape) and `test_path_traversal_is_rejected` → `400` |
| Concurrent edits do not silently overwrite | `PASS` | Stale revision → `409`; external file change detected by hash → `409`; `test_conflict_copy_preserves_both_versions` keeps both files |
| Create / edit / retrieve work via API | `PASS` | `tests/integration/test_notes_api.py` (16 tests) |

**Also verified for this milestone.** Renaming a note or folder preserves note identity and keeps
wiki links/backlinks intact; full-text search returns ranked matches; tags and unresolved links are
reported; reconciliation picks up externally added/changed/deleted files
(`tests/integration/test_notes_reconcile.py`, and `POST /api/notes/reconcile` → `{"added":1,...}` in
the running stack).

**Test evidence (commands actually run):**

- `cd services/api && pytest -q` → `105 passed` (unit + integration against real PostgreSQL).
- `cd apps/web && npm run lint && npm run typecheck && npm run test && npm run build` → clean;
  `vitest` 7 passed.
- Full CI workflow via `act`: `hygiene`, `backend` (105 passed), `frontend` (7 passed),
  `containers` — all four jobs succeeded.

**Not run (recorded, not waived):** Playwright end-to-end tests. The frontend is covered by
component tests and the API by integration tests, but no browser-driven journey is executed yet.

---

## Milestones M3–M9

Acceptance criteria are listed in `ROADMAP.md`. Results are recorded here as each milestone is
executed. Entries remain `NOT RUN` until there is real evidence.

---

## Release Readiness (M9)

| Requirement | Result | Evidence |
|---|---|---|
| REQ-001 Self-hosted | `NOT RUN` | — |
| REQ-002 Free to use (qualified by §3.1) | `NOT RUN` | — |
| REQ-003 Commercial-use rights | `NOT RUN` | — |
| REQ-004 Markdown notes | `NOT RUN` | — |
| REQ-005 Task management | `NOT RUN` | — |
| REQ-006 Project management | `NOT RUN` | — |
| REQ-007 Google Calendar | `NOT RUN` | — |
| REQ-008 Microsoft Outlook | `NOT RUN` | — |
| REQ-009 Calendar consolidation | `NOT RUN` | — |
| REQ-010 Cross-device sync | `NOT RUN` | — |
| REQ-011 Notifications | `NOT RUN` | — |
| REQ-012 OS agnostic | `NOT RUN` | — |
| REQ-013 Security | `NOT RUN` | — |
| REQ-014 Low maintenance | `NOT RUN` | — |
| REQ-015 Data portability | `NOT RUN` | — |
