# Atlas — Architectural Decision Records

**Status:** Draft for approval (Milestone 0)
**Last updated:** 2026-10-20

Each record states context, decision, consequences and status. Proposed decisions are not
binding until the planning gate is approved. Validation findings from Milestone 0 research are
included with sources.

Legend: **Status** ∈ {Proposed, Accepted, Superseded, Rejected}.

---

## ADR-0001 — Modular monolith with a separate worker

**Context.** The product spans notes, tasks, projects, calendars, sync and notifications.
Microservices would multiply operational overhead for a self-hosted, single-owner deployment.

**Decision.** One FastAPI codebase with explicit internal modules, deployed as two processes
(`api`, `worker`) sharing the same code and PostgreSQL. No message broker, no Kubernetes.

**Consequences.** Simple deployment and reasoning; scales to household size. A module boundary
regression is the main maintainability risk, mitigated by keeping provider code inside adapters
and business logic out of clients.

**Status.** Proposed.

---

## ADR-0002 — Two durable stores: PostgreSQL + Markdown filesystem

**Context.** Notes must remain portable files (REQ-004) while structured data needs
transactions, filtering and recurrence (REQ-005/REQ-006).

**Decision.** Note content lives only in `.md` files; PostgreSQL stores note metadata plus all
structured entities. No third datastore, no search cluster (PostgreSQL FTS initially).

**Consequences.** Clear ownership; portable notes. Requires a reconciliation process between
filesystem and metadata index (`MARKDOWN_STORAGE.md`). PostgreSQL FTS is sufficient at this
scale; a dedicated search engine is explicitly out of scope.

**Status.** Proposed.

---

## ADR-0003 — Markdown editor: CodeMirror 6 (source mode) + renderer

**Context.** The editor must support Markdown source mode, preview, keyboard-first editing and
offline-friendly operation without locking content into a proprietary model.

**Decision.** Use **CodeMirror 6** as the source-mode editor (small, actively maintained,
precise Markdown control) with a Markdown renderer for preview. WYSIWYG options (Milkdown,
TipTap/ProseMirror) are *not* adopted for the core editor in the first release because they add
a document-model layer that risks divergence from the on-disk Markdown.

**Consequences.** Guarantees what the user types is what is stored. Fewer formatting niceties
out of the box; acceptable for a portability-first product.

**Validation (M0).** CodeMirror 6 is a current, maintained, programmable text field with
Markdown support; Milkdown/TipTap remain viable alternatives if WYSIWYG is later required.

**Status.** Proposed.

---

## ADR-0004 — Deployment via Docker Compose

**Context.** REQ-014 requires one documented deployment with minimal operations.

**Decision.** Docker Compose with four services (`web`, `api`, `worker`, `db`) and two
persistent volumes (database, Markdown root). Reverse proxy supplied by existing infrastructure.

**Consequences.** Reproducible and portable. Requires users to run Docker; acceptable for the
target audience.

**Status.** Proposed.

---

## ADR-0005 — Durable background jobs on PostgreSQL

**Context.** Calendar sync, retries and reminders must survive worker restarts without a broker
(ADR-0001).

**Decision.** Use a PostgreSQL-backed durable queue. Primary candidate: **Procrastinate**
(Postgres-native, async-friendly, ASGI/FastAPI integration). Documented fallback: **APScheduler
with a persistent SQLAlchemy job store**, or a small `SELECT … FOR UPDATE SKIP LOCKED` queue if
library maintenance becomes a blocker.

**Consequences / risk.** Procrastinate is **actively flagging a need for additional
maintainers** (maintenance risk, see RISKS.md R-05). Mitigation: keep the queue behind the
`jobs` module interface so the implementation is replaceable; the schema in `DATA_MODEL.md`
(§2.5) is intentionally generic.

**Validation (M0).** Procrastinate confirmed as the leading Postgres-native Python task queue;
maintenance status noted. APScheduler + PostgreSQL persists jobs across restarts as a fallback.

**Status.** Proposed.

---

## ADR-0006 — Microsoft integration via delegated OAuth 2.0 (Graph)

**Context.** REQ-008 requires Outlook/M365 calendar access for personal and work accounts.

**Decision.** Use Microsoft Graph with **delegated permissions** via the **authorization code
flow with PKCE**, requesting least-privilege scopes (e.g. `Calendars.ReadWrite`,
`offline_access`). Store refresh tokens encrypted.

**Validation (M0).** Microsoft documents that **all delegated permissions are valid for work or
school accounts, but not all are valid for personal Microsoft accounts**, and that the
**client-credentials (application permission) flow is not supported for personal accounts**
because admin consent cannot be granted for consumer resources. This confirms the delegated
authorization-code approach and rules out app-only sync for personal accounts.

**Consequences.** Per-tenant app registration and consent needed; some organisations restrict
delegated scopes. Treat tenant policy as a Must-Validate early risk (RISKS.md R-01). A
self-hosted app may need to be registered in the user's own tenant or as a multi-tenant app
with a documented registration procedure.

**Status.** Proposed.

---

## ADR-0007 — Mobile delivery and push strategy

**Context.** REQ-011/REQ-012 require reminders on Android and iOS. Desktop can use Web Push.

**Decision.**

- **Desktop:** PWA with Web Push (VAPID) — free and self-hostable.
- **Mobile:** React Native + **Expo** (kept under review), sending pushes either through Expo's
  relay or **directly to FCM (free) and APNs** from the FastAPI/worker backend.

**Validation (M0).** Expo push is a wrapper over FCM/APNs plus a relay; direct FCM/APNs is
supported and avoids the relay dependency. **APNs requires Apple Developer Program membership**
(annual Apple fee) to sign/deliver builds to devices — an unavoidable platform cost with no
free self-hosted substitute.

**Consequences.** Android push can be free (FCM); iOS push carries a platform cost. The
notification design must handle invalid tokens, delivery receipts and retries. This is why
PRODUCT_SPEC §3.1 qualifies "free to use".

**Status.** Proposed.

---

## ADR-0008 — Google integration, OAuth publishing mode, and its refresh-token caveat

**Context.** REQ-007 requires Google Calendar sync for a self-hosted, single-owner app.

**Decision.** Google Calendar API v3 with OAuth 2.0 authorization code flow, incremental sync
via `syncToken`, and least-privilege scopes (prefer `calendar.events`/`calendar.readonly` over
full `calendar` where possible).

**Validation / critical caveat (M0).** Google's OAuth consent screen **publishing status**
affects refresh-token lifetime: apps left in **Testing** mode issue refresh tokens that **expire
after ~7 days**, forcing frequent re-authentication. Publishing to **Production** avoids the
7-day expiry but, for **sensitive scopes**, presents an "unverified app" warning and is subject
to a **100-user cap** until verification. For a personal single-owner deployment, publishing to
Production (unverified) is the pragmatic path; completing Google verification is required only
if the app is shared broadly. This MUST be tested with a real account in M5.

**Consequences.** A weekly-reauthentication trap if configured naively. Documented as a
milestone-critical operational detail (RISKS.md R-13). Google sensitive-scope handling also
requires the OAuth app and its scopes to be declared before use.

**Status.** Proposed.

---

## ADR-0009 — Provider API cost and terms

**Context.** REQ-002 asks for a free product; the integrations must not impose mandatory cost.

**Validation (M0).** Both APIs are free to call within quota: Google Calendar API is free with
per-project/per-user rate limits and a daily threshold; Microsoft Graph is free within
throttling limits. Neither requires a paid subscription for the intended usage.

**Consequences.** Throttling and quota handling are required (backoff + jitter, pagination).
No paid tier is required for the agreed feature set. Platform costs for iOS remain (ADR-0007).

**Status.** Proposed.

---

## ADR-0010 — External Markdown change detection

**Context.** Users may edit note files outside Atlas. The reconciliation mechanism must not
assume filesystem notifications are reliable.

**Decision.** Treat the filesystem as authoritative, but reconcile via a **periodic scan keyed
by content hash** as the reliable baseline, with filesystem notifications (fsnotify) used only
as an *optimisation* to trigger earlier rescans. Reuse the existing revision/conflict machinery
for any note whose file changed underneath an open editor.

**Consequences.** Bounded scan cost proportional to note count; correctness independent of
platform notification behavior. Detailed in `MARKDOWN_STORAGE.md`.

**Status.** Proposed.

---

## ADR-0011 — Authentication approach

**Context.** REQ-013 requires strong authentication without custom cryptography.

**Decision.** Use a maintained authentication approach: FastAPI security with Argon2id password
hashing, server-side session cookies (HttpOnly, Secure, SameSite) with CSRF protection, plus
optional OIDC support via **Authlib**. No custom crypto or auth protocol.

**Consequences.** Single-user simplicity preserved; OIDC available for users who want it.
Rate-limit auth endpoints. Details in `SECURITY.md`.

**Status.** Proposed.

---

## ADR-0012 — API contract via OpenAPI with generated TypeScript types

**Context.** Frontend and backend must not drift.

**Decision.** FastAPI's OpenAPI schema is the contract; the frontend consumes generated
TypeScript types and a thin client. The client never re-implements business rules.

**Status.** Proposed.

---

## ADR-0013 — Task status is an explicit, server-enforced state machine

**Context.** A task's `status` (`inbox`, `next`, `in_progress`, `completed`, `archived`) drives
views, board columns (M4) and completion. Uncontrolled status writes make those inconsistent.

**Decision.** Transitions are validated server-side against one table
(`services/api/atlas/tasks/state.py`, the canonical source):

- the three active statuses (`inbox`, `next`, `in_progress`) may move among themselves and into
  `completed` or `archived`;
- a `completed` task may be reopened (`in_progress`) or archived;
- an `archived` task may be restored to `inbox` or `next`.

A move to the current status is not a transition and is rejected. An invalid transition returns
`409` with the current status, the requested status and the allowed targets; nothing is changed.
`completed_at` is maintained so that it is set exactly when a task is in `completed`.

**Consequences.** Clients must omit unchanged fields (our `PATCH` uses `exclude_unset`). Board
columns and quick actions must reuse this table rather than inventing their own rules.

**Status.** Accepted (M3-03).

---

## Open decisions deferred to later milestones

| # | Question | Milestone |
|---|---|---|
| D-1 | PWA vs packaged desktop app for Linux/Windows/macOS | M8 (default: PWA) |
| D-2 | Expo relay vs direct FCM/APNs | M8 |
| D-3 | Board column model detail | M4 |
| D-4 | Tombstone retention window | M7 |
| D-5 | Whether/when to add external task providers (Google Tasks / MS To Do) | post-release |
| D-6 | Minimum offline feature set | M7 |

## Sources (Milestone 0 research)

- [Procrastinate — PostgreSQL-based Task Queue for Python](https://github.com/procrastinate-org/procrastinate)
- [Microsoft Graph permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference)
- [Use delta query to track changes in Microsoft Graph data](https://learn.microsoft.com/en-us/graph/delta-query-overview)
- [Google Calendar API usage limits](https://developers.google.com/workspace/calendar/api/guides/quota)
- [Google sensitive scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification)
- [Expo push notification services](https://docs.expo.dev/guides/using-push-notifications-services/)
- [CodeMirror / headless Markdown editors comparison](https://md2rich.com/blog/headless-markdown-editors-2026-block-workflows-en)
- [Authlib FastAPI integration](https://docs.authlib.org/en/stable/oauth2/client/web/fastapi.html)
