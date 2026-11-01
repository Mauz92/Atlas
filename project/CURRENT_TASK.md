# Current Task

- Task ID: MU-00
- Status: READY
- Depends on: M1-02 (`DONE`)
- Milestone: MU — Usable Core (docs/ROADMAP.md, ADR-0043)

## Goal
A real-stack journey harness: Playwright runs against the real API and a fresh PostgreSQL database
(not the mocked API used by the existing `apps/web/e2e` specs), with a helper that creates the owner
account. This is the verification gate every later MU task (MU-01…MU-08) depends on.

## Acceptance
- One trivial journey passes against the real stack: setup → login → capture "Buy milk" → it appears in
  the Inbox → reload → it is still there.
- A fresh database is used per run; no state leaks between runs; the app's own database is never used.
- Runs in CI (a PostgreSQL service + the API started from source) and locally with one documented command.
- The existing mocked-API specs keep passing.
- `docs/TESTING.md` documents the harness; `docs/ACCEPTANCE.md` records the evidence.

## Notes
- Account setup rejects reserved email domains (e.g. `.test`) with a bare "Unprocessable Content"; use
  `example.com` addresses in the harness until MU-08 fixes validation and error display.
- Do not start MU-01 until MU-00 is `DONE`. Do not start blocked M5/M6/M8 work.
