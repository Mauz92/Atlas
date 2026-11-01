# Atlas — Calendar Synchronisation

**Status:** Draft for approval (Milestone 0)
**Last updated:** 2026-10-27

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
