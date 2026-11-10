# Atlas — Calendar Synchronisation

**Status:** Stage A (read-only) implemented and fixture-tested; live provider compatibility **UNVERIFIED** (see §12)
**Last updated:** 2026-11-10

Calendar synchronisation is a distributed-systems problem, not a CRUD feature. This document
defines provider behaviour, sync semantics, ownership and conflict policy.

---

## 1. Providers

- **Google Calendar API v3** — OAuth 2.0, incremental sync via `syncToken`, notifications via
  `watch` channels (hints only).
- **Microsoft Graph** — OAuth 2.0 delegated, incremental sync via **delta query**
  (`deltaLink`/`deltaToken`), change notifications via subscriptions (hints only).

Each provider is implemented as a separate adapter behind a common interface (ADR-0006,
ARCHITECTURE §4). Provider-specific code never leaks into application services.

## 2. Authentication

- **Google:** authorization code flow; least-privilege scopes (prefer `calendar.readonly` for
  read stages, `calendar.events`/`calendar.events.readonly` over full `calendar`).
  **Caveat:** OAuth publishing status affects refresh-token lifetime — apps in *Testing* mode
  expire refresh tokens in ~7 days; publish to *Production* for durable tokens (ADR-0008,
  RISKS R-13).
- **Microsoft:** authorization code flow with PKCE, **delegated** permissions
  (`Calendars.ReadWrite`, `offline_access`). **Application-permission (client-credentials) flow
  is not supported for personal accounts** — confirmed in M0 (ADR-0006). Tenant policy may
  restrict scopes (RISKS R-01).
- Tokens stored encrypted; disconnected accounts revoke tokens; secrets never logged.

## 3. Synchronisation Stages

### Stage A — Read-only aggregation (M5)
- Connect accounts; select calendars; display unified view.
- Preserve provider IDs and source information; support pagination, time zones, recurring events.
- Show sync status and failures. **No external writes.**

> **Implemented (M5-08, ADR-0030).** Sync status is derived from the M5-06 cursor rows (never a
> parallel store) and exposed at `GET /api/calendar/sync-status` — per provider/calendar: `connected`,
> `last_success_at`, state (`never_synced` | `idle` | `error`), cursor health and a **safe** last-error
> message (no token, ciphertext or raw cursor value). An optional, strictly user-scoped, idempotent
> manual trigger (`POST /api/calendar/providers/{provider}/sync`) runs one read-only pass over the
> adapter registry seam. A durable `in_progress` state is not reported yet — a synchronous sync persists
> no running flag — and arrives with M5-10.

### Stage B — Reliable incremental sync (M5)
- Store provider cursors (`syncToken` / `deltaLink`); **advance only after changes are committed**.
- Use change notifications to trigger reconciliation; periodic reconciliation as fallback.
- Retry transient failures with bounded exponential backoff + jitter; handle throttling.
- Recover from expired tokens and missed notifications; never duplicate records.

### Stage C — Bidirectional editing (M6)
- Create/update supported events in the owning provider.
- Propagate supported external changes back to Atlas.
- Detect conflicts; respect ownership/permissions; handle deletion/cancellation.
- Prevent feedback loops between local writes and provider echoes.

Bidirectional sync is **not complete** until both directions, deletions, recurring events,
retries and conflicts are tested with real accounts.

## 4. Cursor Safety (non-negotiable)

- A cursor is advanced in the **same transaction** that commits the corresponding changes.
- A cursor is never advanced in a way that can permanently skip unprocessed changes.
- If processing fails partway, the cursor stays put and the work is retried.
- Provider notifications are treated as *hints*, never as a complete change log.

**Implemented (M5-06, ADR-0029).** `atlas/calendar/sync.py::CalendarSyncService` reads the stored
cursor for one `(user, provider, calendar)`, drains **every page** of a pass from the adapter (taking
the durable `next_cursor` from the **final** page only), applies the events and `EventDeletion`
tombstones to `external_events`, advances `sync_cursors` and commits **once**. If anything raises
between applying and committing, the transaction is rolled back, so the cursor is unchanged and the
next pass re-fetches the same changes — verified by a simulated crash-before-commit test. A change
that lands *during* paging is deferred by the adapter's own cursor (the pass returns the revision it
started at) and picked up next pass. A failure records `last_error` on the cursor row in its own
transaction without touching the cursor value; the projection is Atlas-side and a deletion is always
a tombstone.

## 5. Ownership

| Entity | Owner | Write path |
|---|---|---|
| Atlas task | Atlas (PostgreSQL) | Atlas API |
| Google-originated event | Google Calendar | Google API |
| Microsoft-originated event | Microsoft Graph | Graph API |
| Event created by Atlas (Stage C) | the provider it was created in | that provider's API |

A local projection never overrides provider data. Every bidirectional mapping has a documented
lifecycle (created → synced → deactivated/deleted).

## 6. Conflict Policy

When both sides change:

1. **Detect** the conflict (provider version/etag/`If-Match` where available).
2. Determine whether the provider offers a reliable version/concurrency mechanism.
3. Apply a documented safe resolution only when correctness can be established.
4. Otherwise **preserve the conflicting information** and expose a resolution action.
5. Record diagnostics sufficient to investigate **without** logging sensitive event content.

Silent last-write-wins is prohibited as a universal policy. Never silently duplicate, delete or
overwrite an event.

## 7. Task–Calendar Relationship

Three distinct concepts — never conflated:

1. **Task deadline** — a due date in Atlas; does **not** create an external event.
2. **Scheduled work block** — an explicit user-scheduled block, may appear in calendar views.
3. **External calendar event** — owned by Google/Microsoft.

External events are created only when the user explicitly schedules a task or enables a
documented automation. The first release does not auto-convert due dates.

## 8. Unified Calendar UI

Day / week / month views; calendar selection with colour; event details; create/edit for
supported providers; time-zone-aware display; all-day and recurring events; task overlays; a
visible sync status. Use a maintained calendar library rather than a custom rendering engine.

## 9. Provider Limitations to Surface

- Some event fields are not writable or not round-trippable across providers.
- Recurring-event exceptions differ between providers.
- Notifications can be missed or duplicated; reconciliation is the safety net.
- Personal Microsoft accounts support a narrower set of delegated permissions than work accounts.

Unsupported features are reported clearly to the user; they are never silently applied as best
effort.

## 10. Tests Required

Per TESTING.md §5: pagination, create/update, external deletion, recurring instances and
exceptions, time zones/DST, OAuth expiry/revocation, expired sync tokens, throttling, duplicate
prevention, conflicting updates, and worker restarts — plus real-account integration tests with
dedicated test accounts.

---

## 11. Stage A implementation summary (ADR-0071, ADR-0072)

| Piece | Where | Notes |
|---|---|---|
| OAuth (code + PKCE S256, `state` single-use, session-bound, TTL 10 min) | `atlas/calendar/oauth.py`, `atlas/api/calendar_accounts.py` | Redirect URI is **always** `{PUBLIC_BASE_URL}/api/calendar/{google,microsoft}/callback`. Scopes: Google `calendar.readonly`; Microsoft `Calendars.Read` + `offline_access`. No write scope is requested in Stage A. |
| Google adapter | `atlas/calendar/google.py` | REST via `httpx`; `singleEvents=false` + local expansion (D4); `syncToken`; `410` -> full snapshot resync. |
| Microsoft adapter | `atlas/calendar/microsoft.py` | `calendarView/delta` over a rolling window (default -90/+365 days); Graph expands occurrences; `410`/window renewal -> snapshot. |
| ICS feed adapter (Proton and any ICS URL) | `atlas/calendar/ics.py`, `feed.py`, `netguard.py` | Secret URL sealed at rest, masked in the UI, SSRF-guarded, conditional GET, diffing deletions. |
| Recurrence | `atlas/calendar/recurrence.py` | `python-dateutil` only; wall-clock expansion in the event's own zone. |
| Unified view API | `GET /api/calendar/events`, `/events/{id}` | UTC instants + event zone + all-day dates; window <= 100 days; paginated. |
| Jobs | `calendar.reconcile` (5 min scan), `calendar.sync_user` (immediate, one-off) | Cursor advances only inside the commit that applies its changes (ADR-0029). |
| Diagnostics | `atlas-admin calendar-status [--email]` | Read-only; prints no token, URL, title or provider id. |

**Decisions worth knowing**

- *Disconnect* deletes the credential, the account's calendars, cursors and **projected events** (a cache of
  provider-owned data; reconnecting re-syncs). Google's refresh token is revoked at Google; the Microsoft v2.0
  endpoint has no revocation API, so remove the app at `account.live.com/consent/Manage` (personal) or
  `myapps.microsoft.com` (work). *Hiding* a calendar keeps its projection and cursor.
- One Google account and one Microsoft account per Atlas user (the credential store is keyed by user + provider);
  any number (max 20) of ICS feeds.
- The calendar list refreshes on connect and on "Sync now" (not on every scan).
- Webhook change notifications (Google `watch`, Graph subscriptions) are **not used**: they need a public HTTPS
  endpoint, and Atlas is private (tailnet-only; ROADMAP SEC-01). Polling plus the reconciliation scan is the
  mechanism (M5-09 stays `BACKLOG`).
- Microsoft events outside the rolling window are not synced; Google syncs the full history.
- Floating ICS times and all-day events use the feed's `X-WR-TIMEZONE`, else UTC. A `TZID` that is neither IANA nor
  a mapped Windows name falls back to that zone (an embedded custom `VTIMEZONE` rule set is not honoured for
  recurrence). `RANGE=THISANDFUTURE` overrides are treated as single overrides.

## 12. Setup guide

> **Honesty note.** Everything below was built from the providers' documentation and verified against local
> fixtures only. Nothing has been run against Google, Microsoft or Proton. Console screens change; if a label
> differs, follow the intent and tell the maintainer. Follow §12.7 after connecting to produce the live evidence
> that M5-00/M5-03/M5-04/M5-11 need before they can be `DONE`.

### 12.1 The URL Atlas uses (read this first)

Atlas builds every redirect URI from `PUBLIC_BASE_URL`; it is never hard-coded.

| Setup | `PUBLIC_BASE_URL` | Redirect URIs to register |
|---|---|---|
| Owner's private setup (DuckDNS name -> tailnet address, TLS on port 9443, DEPLOYMENT.md §8.3) | `https://galaxia-atlas.duckdns.org:9443` | `https://galaxia-atlas.duckdns.org:9443/api/calendar/google/callback` and `https://galaxia-atlas.duckdns.org:9443/api/calendar/microsoft/callback` |
| A future public name on 443 (only after SEC-01) | `https://galaxia-atlas.duckdns.org` | `https://galaxia-atlas.duckdns.org/api/calendar/google/callback`, `.../microsoft/callback` |
| Local development | `http://localhost:8000` | `http://localhost:8000/api/calendar/google/callback` (Google and Microsoft both allow `http://localhost`) |

- The registered URI must match **character for character**, including the `:9443` port, the scheme and the absence
  of a trailing slash. A mismatch is `redirect_uri_mismatch` (Google) or `AADSTS50011` (Microsoft).
- The name resolves to the server's **tailnet address only**. That is fine for OAuth: the redirect is performed by
  *your browser*, so connect from a device that is on the tailnet. Google and Microsoft never call Atlas directly.
  Atlas stays private until the SEC-01 audit; do not forward ports or point the name at a public address to make
  this work.
- Settings -> Calendar shows the exact redirect URI for your `PUBLIC_BASE_URL` (copy it from there), and
  `atlas-admin calendar-status` prints it too. `http://` with a non-loopback host is refused ("not configured").
- Provider change-notification webhooks need a *public* endpoint and are not used; Atlas polls and reconciles.

### 12.2 Google (real account, manual connection only)

Use your own Google account when connecting by hand. Never use it in automated tests (AGENTS.md §11).

1. <https://console.cloud.google.com> -> create a project (e.g. "Atlas").
2. *APIs & Services -> Library* -> enable **Google Calendar API**.
3. *OAuth consent screen* (Google Auth Platform -> Branding/Audience): User type **External**; app name, support
   and developer e-mail. Add your Google account under **Test users** while the app is in *Testing*.
4. *Data access / Scopes*: add only `.../auth/calendar.readonly` (a **sensitive** scope: it triggers the
   "Google hasn't verified this app" screen; for a personal app click *Advanced -> Go to Atlas (unsafe)*).
5. **Publish the app to Production** (Audience -> *Publish app*). In *Testing* mode Google expires refresh tokens
   after **7 days**, which would silently disconnect Atlas every week (RISKS R-13). Publishing an app for one
   user does not require verification; the warning screen simply stays. Verification is only needed for >100 users.
6. *Credentials -> Create credentials -> OAuth client ID* -> type **Web application**. Under *Authorised redirect
   URIs* add the exact URI from §12.1 (e.g. `https://galaxia-atlas.duckdns.org:9443/api/calendar/google/callback`).
   (No JavaScript origin is needed: the secret stays on the server.)
7. Copy the client id and secret into the server `.env`: `GOOGLE_CLIENT_ID=...`, `GOOGLE_CLIENT_SECRET=...`
   (never commit them). Restart: `docker compose -f deploy/docker-compose.yml up -d api worker`.
8. Atlas -> Settings -> Calendar -> Google Calendar -> **Connect**, sign in, tick the calendar permission (an
   unticked box is refused: "permission missing"), then choose which calendars to show.

### 12.3 Microsoft Outlook / Microsoft 365

1. <https://entra.microsoft.com> -> *Identity -> Applications -> App registrations -> New registration*.
2. **Supported account types**: for a personal Outlook.com/Hotmail account choose *"Accounts in any organizational
   directory and personal Microsoft accounts"* (`MICROSOFT_TENANT=common`) or *personal only* (`consumers`).
   **Do not register the app in an employer's tenant, or connect a work account, without that organisation's IT
   approval** (AGENTS.md §11: no bypassing organisation security policy). A work tenant may block user consent
   (*"Need admin approval"*); that is a decision for its administrator, not something to work around.
3. **Redirect URI**: platform **Web**, the exact URI from §12.1 (`.../api/calendar/microsoft/callback`).
4. *API permissions -> Add -> Microsoft Graph -> Delegated*: **Calendars.Read** (and `offline_access`, which allows
   refresh tokens). Do not add `Calendars.ReadWrite` (Stage B).
5. *Certificates & secrets -> New client secret*; copy the **Value** immediately (it is shown once). Note its
   expiry date: when it expires, connections fail until you create a new secret.
6. `.env`: `MICROSOFT_CLIENT_ID=<Application (client) ID>`, `MICROSOFT_CLIENT_SECRET=<secret value>`,
   `MICROSOFT_TENANT=common` (or `consumers`/a tenant id). Restart api and worker.
7. Settings -> Calendar -> Microsoft Outlook -> **Connect**. To revoke later, remove the app at
   `account.live.com/consent/Manage` (Atlas cannot revoke Microsoft tokens; "Disconnect" deletes them locally).

### 12.4 ProtonMail calendar (ICS feed)

Proton Calendar has **no public API** and Proton Bridge does not cover calendars. The supported route is a secret
read-only ICS link.

1. Proton Calendar (web) -> hover the calendar -> *Settings* (gear) -> **Share via link** -> *Create link* with
   **View only (full details)**, then *Copy link*.
2. Atlas -> Settings -> Calendar -> **Add calendar feed (ICS)** -> paste the link, give it a name and a colour ->
   **Test** (shows the event count, nothing is stored) -> **Add feed**.

Limits and handling:

- **Read-only**, no write-back. Atlas shows what the feed contains.
- Proton regenerates feed content **infrequently** (expect minutes to hours of delay); polling more often does not
  help. Atlas polls every `ICS_POLL_SECONDS` (default 900, minimum 300) with a conditional GET.
- The link is a **secret**: anyone who has it can read the calendar. Atlas stores it encrypted, shows only
  `https://host/........`, never logs it and never returns it from the API. **To revoke**, delete the link in
  Proton and create a new one, then remove the old feed in Atlas and add the new link.
- A revoked link shows "feed link rejected"; an unreachable host shows "feed unreachable". The last good events
  stay visible until the feed works again or you remove it.
- Feeds must be `https://` and on a public address (private/loopback/metadata addresses are refused; SECURITY T24).
  Any other ICS URL works the same way (Nextcloud, holiday calendars, ...).

### 12.5 Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PUBLIC_BASE_URL` | `http://localhost:8000` | Base of every redirect URI (see §12.1) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | empty | Empty = Google "not configured" (UI shows setup help) |
| `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` / `MICROSOFT_TENANT` | empty / empty / `common` | As above |
| `ICS_POLL_SECONDS` | 900 | Feed poll interval (>= 300) |
| `ICS_MAX_BYTES`, `ICS_TIMEOUT_SECONDS` | 10 MiB, 20 | Feed size cap and timeout |
| `ICS_ALLOW_HTTP`, `ICS_ALLOW_PRIVATE_HOSTS` | false | Development only; the API refuses to start with the second in production |
| `CALENDAR_WINDOW_PAST_DAYS` / `_FUTURE_DAYS` | 90 / 365 | Microsoft delta window |
| `CALENDAR_OAUTH_STATE_TTL_SECONDS` | 600 | OAuth `state` lifetime |
| `CALENDAR_FAKE_PROVIDER_URL` | empty | Tests only; refused in production |

`TOKEN_ENCRYPTION_KEY` encrypts the stored tokens and feed URLs: back it up with the database (losing it means
reconnecting every account and re-adding every feed). Startup logs a warning when only one of a client id/secret pair
is set or `PUBLIC_BASE_URL` is not https. Check what a container received with
`docker compose -f deploy/docker-compose.yml exec api env | grep -E 'GOOGLE|MICROSOFT|ICS_|PUBLIC_BASE'` (do not paste the output anywhere: it contains secrets).

### 12.6 Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Google `redirect_uri_mismatch` | Registered URI differs from the one Atlas sent (port, scheme, trailing slash, `PUBLIC_BASE_URL` changed) | Copy the URI shown in Settings -> Calendar into the console exactly; restart after changing `PUBLIC_BASE_URL` |
| Microsoft `AADSTS50011` | Same, for Entra | Same; the platform must be **Web** |
| `access_denied` / "Connection cancelled" | You pressed Cancel, or the app is in Testing and your account is not a test user | Add yourself as a test user (Google), or retry and accept |
| "Calendar permission was not granted" | The calendar checkbox was unticked on Google's screen | Connect again and leave it ticked |
| "No refresh token" | Account previously granted without offline access | Remove Atlas at `myaccount.google.com/permissions`, connect again |
| `invalid_grant` / "needs re-authorisation" | Refresh token revoked, password changed, 7-day Testing expiry, or Microsoft secret/consent withdrawn | Publish the Google app to Production; click **Reconnect** |
| Microsoft "admin consent required" / `AADSTS65001` | Tenant blocks user consent | Personal account, or ask the tenant's administrator; do not work around it |
| "Not configured" card | Client id/secret empty, or `PUBLIC_BASE_URL` not https | Set `.env`, restart api and worker |
| Sync status "resync" after a long outage | Google `410 Gone` / Graph delta expired | Automatic: Atlas relists everything and tombstones what vanished; nothing to do |
| Feed "link rejected" | Proton link revoked/regenerated | Create a new link and replace the feed |
| Feed "blocked" | Private/non-https address | Use the public https link |
| Everything stale | Worker down | `docker compose ... ps`; `atlas-admin calendar-status` |

### 12.7 Live-check runbook and evidence template (M5-00, M5-03, M5-04, M5-11)

Run once after connecting the real accounts; keep it out of the repository if it contains personal data (record
*counts and yes/no*, never titles or addresses). Until this is filled in, these tasks stay `IN_REVIEW` / blocked on
live verification and REQ-007/008/009 stay "UNVERIFIED".

1. `docker compose -f deploy/docker-compose.yml exec api atlas-admin calendar-status` -> record: configured yes/no,
   redirect URI, scopes granted (must be exactly the read-only ones), token expiry.
2. Connect Google; **Sync now**; record number of calendars/events and that all-day, a timed event in another time
   zone, a recurring series with one moved and one deleted occurrence, and a multi-day event display correctly
   (compare with Google Calendar side by side, in both light/dark and on a phone).
3. Delete one event and edit another in Google; within the next scan (<= 5 min) confirm Atlas matches (deletion = tombstone).
4. **Refresh-token lifetime:** with the Google app *published*, record the date of connection; after **> 7 days**
   confirm syncing still works without reconnecting (state the date you checked).
5. Repeat 2-3 for Microsoft; also change a recurring occurrence and cancel one; note the window limits observed.
6. Add the Proton link; record event count, time until a change made in Proton shows up in the feed (delay), and
   that regenerating the link makes Atlas show "link rejected" while keeping the last events.
7. Disconnect Google (check `myaccount.google.com/permissions` no longer lists Atlas) and Microsoft (remove at the
   Microsoft consent page); reconnect once to confirm a clean restart.
8. Revocation test: revoke Atlas in the provider console, wait for a scan, confirm the card says
   "needs re-authorisation" and Reconnect fixes it.

Evidence template (copy into `docs/ACCEPTANCE.md` under M5-00 when done):

```
M5-00 live evidence - date: ____  by: ____
Google:  scopes granted ____ | calendars ____ events ____ | all-day ok Y/N | tz ok Y/N | recurrence+exception ok Y/N
         delete propagated Y/N (after __ min) | refresh worked after >7 days (checked on ____) Y/N | disconnect revoked Y/N
Microsoft: account type ____ | scopes ____ | same checks as above | window behaviour noted ____
Proton:  events ____ | change visible after ____ | revoked link -> "rejected" Y/N | last events kept Y/N
Problems / surprises: ____
```

### 12.8 Limits of Stage A

Read-only; one Google and one Microsoft account per user; no invitations/RSVP; no attendee list; the calendar list
refreshes on connect and "Sync now"; webhooks are not used; Proton delay is outside Atlas's control.
