# Atlas — Architecture

**Status:** Draft for approval (Milestone 0)
**Last updated:** 2026-10-20

This document describes the actual system boundaries Atlas targets. It reflects the
proposed architecture; sections marked *Assumption* or *To validate* are not yet proven by
implementation. Implementation choices with trade-offs are recorded in `DECISIONS.md`.

---

## 1. Architectural Goals and Constraints

- **Modular monolith.** One backend application with clear internal module boundaries, plus a
  separate worker process. No microservices, no message broker, no Kubernetes, no second
  datastore.
- **Two durable stores only:** PostgreSQL (structured data + durable job/sync state) and the
  Markdown filesystem (note contents).
- **Explicit ownership.** Every entity has exactly one source of truth (§5).
- **Integrations behind adapters.** Provider-specific code never leaks into application
  services.
- **Thin clients.** Authoritative business logic lives in the API. Clients cache and render.
- **Fail-safe by default.** Correctness and recoverability over speed. No silent overwrites.

## 2. Component Overview

```
                        ┌──────────────────────────────────────────┐
                        │            Clients                        │
                        │  Web / PWA (React + TS)                   │
                        │  Mobile (React Native + Expo)  [M8]       │
                        └───────────────┬──────────────────────────┘
                                        │ HTTPS / JSON (OpenAPI)
                        ┌───────────────▼──────────────────────────┐
                        │        api (FastAPI, Python)              │
                        │  auth · notes · tasks · projects ·        │
                        │  calendar views · sync · preferences      │
                        └───┬───────────────┬──────────────┬───────┘
                            │               │              │
              ┌─────────────▼──┐   ┌────────▼───────┐  ┌───▼─────────────────┐
              │  Markdown root │   │  PostgreSQL    │  │ provider adapters   │
              │  (note files)  │   │  (structured)  │  │ Google / Microsoft  │
              └───────┬────────┘   └───────┬────────┘  └───┬─────────────────┘
                      │                    │               │
                      │            ┌───────▼────────┐      │
                      └────────────┤ worker         ├──────┘
                        reconcile  │ sync · retries │
                                   │ reminders      │
                                   └────────────────┘
```

**Components**

1. **Clients** — browser/PWA first (M1+), native mobile later (M8). Thin; use the API.
2. **api** — FastAPI application. Authentication, notes, tasks, projects, calendar views,
   sync endpoints, user preferences, OpenAPI contract.
3. **worker** — durable background processing: calendar synchronisation, retries, reminder
   scheduling. Same codebase as `api`, separate process/deployment.
4. **Markdown storage** — server-side directory of real `.md` files (see `MARKDOWN_STORAGE.md`).
5. **PostgreSQL** — structured entities, provider mappings, sync cursors, job queue, reminder
   state (see `DATA_MODEL.md`).
6. **Provider adapters** — Google Calendar and Microsoft Graph behind a common interface.

Google and Microsoft remain authoritative for events they own. Atlas keeps a local
projection for display and controlled updates.

## 3. Deployment Topology

Docker Compose services (see `DEPLOYMENT.md`):

| Service | Role | Exposure |
|---|---|---|
| `web` | Serves the built frontend (static) | Behind reverse proxy |
| `api` | FastAPI application | Behind reverse proxy (HTTPS) |
| `worker` | Background jobs | Not exposed |
| `db` | PostgreSQL | Private network only |

- Only `web` and `api` are reachable through the reverse proxy. `db` and `worker` are never
  published.
- Reverse proxy (existing infra) terminates TLS.
- Volumes persist the database and the Markdown root across restarts and upgrades.

## 4. Module Boundaries (backend)

The backend is organised into modules with explicit interfaces; modules do not reach into
each other's internals.

| Module | Responsibility | Depends on |
|---|---|---|
| `auth` | Users, sessions, password/login, CSRF, rate limiting | `db` |
| `notes` | Markdown FS operations, revisions, search index, links | `storage`, `db` |
| `tasks` | Task lifecycle, recurrence expansion, subtasks | `db` |
| `projects` | Projects, boards, progress calculation | `db` |
| `calendar` | Unified view, mapping of local records to provider objects | `db`, `providers` |
| `providers` | Adapter interface + Google/Microsoft implementations | external APIs |
| `sync` | Revision-aware change feed, tombstones, client reconciliation | `db` |
| `jobs` | Durable queue enqueue/claim/complete, retry policy | `db` |
| `notifications` | Reminder scheduling, device tokens, delivery attempts | `jobs`, `db` |
| `ops` | Health, logging, backup/export entry points | all (read-only) |

`api` and `worker` import the same modules; only the process entry points differ.

## 5. Data Ownership

| Entity | Source of truth | Local representation |
|---|---|---|
| Markdown note contents | Markdown files on the server | FS |
| Note folder structure | Server-side Markdown directory | FS |
| Tasks created in Atlas | PostgreSQL | PostgreSQL |
| Projects and settings | PostgreSQL | PostgreSQL |
| Task completion state | PostgreSQL | PostgreSQL |
| Google-originated event | Google Calendar | PostgreSQL projection |
| Microsoft-originated event | Microsoft Graph | PostgreSQL projection |
| External sync state (cursors, mappings) | PostgreSQL | PostgreSQL |
| User preferences | PostgreSQL | PostgreSQL |
| OAuth credentials | Encrypted server-side secret storage | PostgreSQL (encrypted) |

Rules:

- A synchronised external event is a **projection**, never an independent duplicate with
  ambiguous ownership. Each projection stores the provider and the provider event ID.
- Note contents are never stored exclusively in PostgreSQL. PostgreSQL holds only note
  *metadata* (path, revision/hash, tags, indexed links) for search and sync.
- Task due dates and scheduled blocks are distinct concepts from external calendar events.

## 6. Key Request Flows

### 6.1 Note save (revision-checked)

1. Client sends `PUT /notes/{id}` with the revision it last read.
2. API resolves the path, rejects traversal, and compares the supplied revision to the
   current on-disk revision.
3. If unchanged: atomic write (temp file + rename), compute new content hash, update metadata,
   emit a change event.
4. If changed: return `409 Conflict` with the current revision. The client presents a merge or
   preserves a conflict copy. No silent overwrite. (See `MARKDOWN_STORAGE.md`.)

### 6.2 Task mutation (idempotent)

1. Client sends a mutation with a client-generated idempotency key.
2. API applies the change inside a transaction, records the resulting revision, and writes a
   change-log row.
3. Duplicate requests with the same key return the original result without re-applying.

### 6.3 Calendar read sync (Stage A/B)

1. `worker` claims a sync job for a connected calendar account.
2. Adapter performs an incremental pull using the stored cursor/delta link.
3. Changes are upserted into the event projection inside a transaction; on success only, the
   cursor is advanced.
4. Failures classify as retryable (backoff + jitter) or terminal (surface to sync status).
5. Provider change notifications (webhooks) are treated as *hints* that trigger reconciliation,
   never as complete change logs.

### 6.4 Calendar write sync (Stage C)

1. Client edits a supported event that Atlas owns a mapping for.
2. API routes the write to the owning provider adapter.
3. On success, the local projection is updated with the provider's returned version.
4. Conflicts are detected via provider version/`If-Match` semantics where available; otherwise
   they are preserved and surfaced for explicit resolution. No silent last-write-wins.

## 7. Synchronisation Model (overview)

Full semantics in `DATA_MODEL.md` and `CALENDAR_SYNC.md`.

- Stable UUIDs for all structured entities.
- Every mutable row carries a monotonically increasing `revision`.
- A change log (per user) supports incremental client pulls: "give me everything after
  revision N".
- Deletes produce tombstones so offline clients cannot resurrect deleted entities.
- Mutations are idempotent via client-supplied keys.
- Clients queue offline mutations durably and replay them on reconnect, checking the revision
  they based the edit on.

**Local-first direction (ADR-0055, proposed protocol in ADR-0059).** Desktop and Android clients keep a full local
copy (SQLite; desktop notes as a real folder of `.md` files) and sync with this server, which stays the hub, the
durable backup and the owner of accounts and provider tokens. What the server does today versus what the
local-first clients need — change-feed coverage, field-level and three-way merge, client ids, device
credentials, versioning, retention — is analysed and specified in [`SYNC_PROTOCOL.md`](SYNC_PROTOCOL.md). Until
that is accepted and implemented, the paragraph above describes the browser queue only.

## 8. Client Architecture and UX

- **Web/PWA:** React + TypeScript, a maintained accessible component library, generated API
  types from OpenAPI. Progressive Web App installability and Web Push (VAPID) for desktop.
- **Mobile (M8):** React Native + Expo, if it remains the best-maintained fit (ADR-0007).
- **Navigation:** Today, Inbox, Upcoming, Tasks, Projects, Calendar, Notes, Search, Settings.
- **Today view:** today's scheduled tasks, due/overdue, upcoming events, unscheduled tasks,
  reminders, quick capture, review of unfinished work. No decorative dashboards.
- Business logic (recurrence, conflict resolution, authorisation) is server-side only.

## 9. Assumptions and Validations

**Assumptions**

- A1: Small-scale personal/household deployment.
- A2: Server reachable over HTTPS (directly or via reverse proxy) for OAuth callbacks and
  push webhooks.
- A3: Primary calendar accounts are personal Google and personal/M365 Microsoft accounts.

**Validated in Milestone 0** (evidence in `DECISIONS.md`):

- V1: A PostgreSQL-backed durable queue is available for Python without a broker; maintenance
  risk documented (ADR-0005).
- V2: Microsoft Graph delegated permissions work for both personal and work accounts, but
  client-credentials flow does **not** work for personal accounts (ADR-0006).
- V3: Google Calendar and Microsoft Graph APIs are free to call, with quotas (ADR-0009).
- V4: iOS push requires an Apple Developer Program membership — a platform cost (ADR-0007).
- V5: A maintained source-mode Markdown editor exists (CodeMirror 6) (ADR-0003).

**To validate later (do not block the gate):**

- Microsoft tenant policy constraints on app registration (M5).
- Google OAuth publishing-mode effect on refresh-token lifetime (M5) — critical operational
  detail, see ADR-0008 / RISKS.md R-13.
- iOS/Android push on physical devices (M8).
