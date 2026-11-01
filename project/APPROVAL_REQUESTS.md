# Approval Requests

## AR-001 — M5-00: calendar provider validation requires real accounts

- **Requested:** 2026-10-26
- **Task:** M5-00 — validate Microsoft tenant + Google publishing mode with real accounts
  (docs/ROADMAP.md M5; the M5 entry gate).
- **Exact action needed:** create/authorise a Google Cloud OAuth client (Calendar API, read-only
  scopes) and a Microsoft Entra app registration (Graph `Calendars.Read`, delegated) — one
  throwaway test account each — and supply the client IDs/secrets in a local, git-ignored place so
  the OAuth flow can be run once and the refresh-token/scopes/publishing-mode behaviour recorded.
- **Reason:** AGENTS.md §7.5/§10/§18 and M5-00 require *real* provider behaviour; mocks are not
  sufficient evidence of provider compatibility, and M5's gate ("real calendar data synced safely")
  cannot be closed without it. The Microsoft side in particular (tenant policy, Azure SSO, WAM
  prompts, admin consent) cannot be established by guessing.
- **Risk (why this needs approval):** connecting external accounts, storing OAuth secrets, and
  touching third-party APIs with account credentials. Reversible: the accounts are throwaway and
  scopes are read-only; tokens are stored encrypted (M5-01) and never committed.
- **Data/services affected:** Google Calendar API + Microsoft Graph (read-only); local encrypted
  credential store only. No user content is sent to any third party.
- **Rollback:** revoke the OAuth client/registration and delete the stored tokens.
- **Blocking:** M5-00, and the real-account integration tests in M5-03/M5-04 and M6-08.
- **Owner decision:** _pending_.
