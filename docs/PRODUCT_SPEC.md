# Atlas — Product Specification

**Status:** Draft for approval (Milestone 0)
**Owner:** Product owner (user)
**Last updated:** 2026-11-01

This document is the approved source of truth for *what* Atlas must do. It states
requirements, boundaries and acceptance principles. It does not prescribe *how* —
implementation choices live in `ARCHITECTURE.md` and `DECISIONS.md`.

---

## 1. Product Vision

Atlas is a self-hosted productivity environment with a single coherent interface for
capturing information, organising work, planning tasks and managing calendars. It replaces
the fragmented workflow of separate notes, task and calendar applications without
becoming a fragile integration project.

A user must be able to:

1. Capture an idea immediately.
2. Write and organise long-form Markdown notes.
3. Convert a note into one or more tasks.
4. Assign tasks to projects, dates and priorities.
5. See tasks alongside external calendar commitments.
6. Review daily, weekly and upcoming work.
7. Track project progress through lists and Kanban boards.
8. Receive reminders on supported devices.
9. Access the same information from another device.
10. Back up, export and recover all essential data without a commercial SaaS dependency.

### 1.1 Product direction (owner statement, 2026-11-01)

Atlas is the owner's **personal operating system**: an Obsidian/Notion-class knowledge workspace
with the planning functions built in, instead of bolted on through plugins. Notes, tasks, projects
and calendar events are one connected workspace, not four apps sharing a login. Concretely:

- **Notes are the centre.** Everything else hangs off them: a task can come from a note, a note
  can belong to a project, a day has a daily note, and links run in both directions.
- **Everything is reachable in a keystroke.** One command palette / quick switcher opens any note,
  task or project and runs any common action. The product is judged by how fast the daily loop is
  (capture → triage → plan → do → review), not by how many endpoints exist.
- **Built in, not configured.** Tasks, projects, planning, calendar and reminders work out of the box;
  the user does not assemble them from plugins.
- **A feature exists only when a person can use it.** A capability that is reachable only through the
  API counts as *not delivered* for the owner-facing requirement (see §3 closing paragraph).

Notion-style user-defined databases/views, graph view and a canvas are **not** adopted by this
statement. They were decided on 2026-11-01 (`DECISIONS.md` ADR-0043, D-1…D-4): databases/views and graph are
deferred until after MU-06, the editor stays CodeMirror 6, and plugins/scripting stay excluded —
all to avoid a second source of truth (AGENTS.md §2, §15).

## 2. Product Principles

- **Local ownership.** The application, database and notes run on infrastructure the user
  controls. External services are only involved where a calendar must be synchronised.
- **Markdown portability.** Notes are genuine `.md` files, readable and editable outside
  Atlas. Atlas is never required to access the user's notes.
- **Minimal configuration.** The default installation is usable without configuring dozens
  of plugins or integrations.
- **Safe synchronisation.** Sync is observable, recoverable and resistant to duplicates,
  network failure and conflicting edits.
- **Cross-platform consistency.** Business logic behaves identically across operating
  systems; only presentation adapts.
- **Progressive complexity.** The default interface is simple; advanced settings exist but
  never obstruct daily workflows.

## 3. Non-Negotiable Requirements

| ID | Requirement | Acceptance principle |
|---|---|---|
| REQ-001 | Self-hosted | Core app, database and sync run on user-controlled infrastructure. |
| REQ-002 | Free to use | No mandatory subscription or paid application feature. |
| REQ-003 | Commercial-use rights | All dependencies permit intended personal and workplace use. |
| REQ-004 | Markdown notes | Notes are stored as actual `.md` files. |
| REQ-005 | Task management | Inbox, due dates, priorities, recurrence, subtasks, project assignment. |
| REQ-006 | Project management | Projects, task lists, Kanban boards, progress, project notes. |
| REQ-007 | Google Calendar | OAuth-based integration and automated event synchronisation. |
| REQ-008 | Microsoft Outlook | Microsoft Graph integration for compatible personal and M365 accounts. |
| REQ-009 | Calendar consolidation | Multiple calendars viewable in one interface. |
| REQ-010 | Cross-device sync | Changes propagate across authorised clients without manual export/import. |
| REQ-011 | Notifications | Supported desktop and mobile platforms receive task/event reminders. |
| REQ-012 | OS agnostic | Linux, Windows, Android and the web (PWA) are product targets. **Amended 2026-11-04 (ADR-0068 Q9, owner):** iOS and macOS are out of scope for the native clients; the PWA works in any modern browser, including on those systems. |
| REQ-013 | Security | Strong authentication, protected credentials, access control, recoverable backups. |
| REQ-014 | Low maintenance | One documented deployment, automated migrations, straightforward updates. |
| REQ-015 | Data portability | Complete export of notes, tasks, projects and relevant metadata. |

A requirement is **not** satisfied because a button or settings screen exists. It is
satisfied only when demonstrated to work under realistic conditions, with evidence recorded
in `ACCEPTANCE.md`. Conversely, a capability reachable only through the API does **not** satisfy a
user-facing requirement: the owner must be able to perform it in the interface (decision ADR-0043).

### 3.1 Cost and platform qualifications (disclosed, not violations)

REQ-002 concerns the *application*. Two platform realities are explicitly disclosed and do
not violate REQ-002, but must be understood before committing to mobile delivery:

- **iOS distribution requires an Apple Developer Program membership** (an annual Apple fee)
  to sign and deliver push-enabled builds to real devices. There is no free self-hosted
  path to iOS push. See `DECISIONS.md` ADR-0007.
- **Mobile push for Android** can be delivered with free Firebase Cloud Messaging, or via a
  third-party relay. Any relay is an external dependency requiring disclosure. See
  ADR-0007.

These are platform costs, not Atlas licence costs. They are recorded here so the product is
never described as "free on iOS" without qualification.

## 4. Explicit Product Boundaries

### 4.1 Included in the initial release

- Markdown notes and folders; full-text search; wiki-style links; tags; daily notes; note templates.
- A global command palette / quick switcher and unified search across notes, tasks and projects.
- Explicit note↔task↔project linking, including creating a task from a note.
- Task capture, task lists, priorities, due dates, reminders, recurrence, subtasks.
- Projects, project boards (Kanban), project notes, derived progress.
- Daily and weekly planning; Today and Upcoming views.
- Consolidated read-only external calendars, then bidirectional editing in a later milestone.
- Calendar-to-task association (explicit, not automatic).
- Cross-device synchronisation; basic offline access and recovery.
- Secure backups, restore, and full data export.

### 4.2 Excluded from the initial release

- Real-time multiplayer Markdown editing.
- Public note publishing.
- A plugin marketplace.
- Custom scripting inside notes.
- Arbitrary user-defined automation engines.
- Enterprise/portfolio resource management; billing or subscription management.
- AI-generated notes, summaries or task planning.
- A calendar server replacing Google/Microsoft; full parity with Obsidian/TickTick/Planner.

Excluded items may be reconsidered only after the core product is stable, via a documented
scope decision.

## 5. Feature Requirements

### 5.1 Notes (REQ-004)

- Notes are ordinary UTF-8 Markdown files under a configurable root directory.
- The editor supports source mode and rendered preview.
- Support headings, lists, checklists, tables, fenced code, relative links, `[[wiki links]]`,
  tags, optional YAML frontmatter, and relative-path attachments.
- Frontmatter is optional; no metadata template is required to write a note.
- Note contents are never stored exclusively in PostgreSQL.
- Note revisions are tracked; concurrent edits never silently overwrite.

Detailed semantics: `MARKDOWN_STORAGE.md`.

### 5.2 Tasks (REQ-005)

- Tasks are structured PostgreSQL entities with stable UUIDs.
- Fields: status, priority, timestamps, optional schedule, due date, optional time zone,
  duration estimate, completion time, project, parent task, linked notes, tags, recurrence,
  reminders, external IDs, tombstone state, revision.
- Recurrence uses a standard rule (RFC 5545 RRULE semantics); completing one occurrence
  must not complete future occurrences.
- Every mutation is transactional and idempotent under retry.

Detailed model: `DATA_MODEL.md`.

### 5.3 Projects (REQ-006)

- Projects have name, description, status, optional dates, tasks, notes, board view and a
  documented progress calculation.
- Tasks may exist without a project; membership is never forced.
- Board columns derive from task status. The board is a project's **Board** tab (there is no standalone board page since ADR-0064; a task
  with no project is on no board).
- Progress is **derived, not stored** (see `DATA_MODEL.md` §2.3). The canonical formula is:
  `total` = the project's live (`deleted_at IS NULL`), non-`archived` tasks; `completed` = those
  whose status is `completed`; the reported percentage is `round(completed × 100 / total)` to the
  nearest whole percent (halves rounded up), and **0** when `total` is 0 (a project with no countable
  tasks is not complete). Soft-deleted (tombstoned) tasks, `archived` tasks, and tasks filed under
  another project or under none never count. Decision: ADR-0023; implementation:
  `services/api/atlas/projects/progress.py`.

### 5.4 Calendar (REQ-007, REQ-008, REQ-009)

- Separate provider adapters for Google Calendar and Microsoft Graph.
- OAuth 2.0 with least-privilege delegated scopes; refresh tokens stored encrypted.
- Stage A: read-only aggregation. Stage B: reliable incremental sync. Stage C: bidirectional
  editing for supported event types.
- Provider remains authoritative for externally owned events; Atlas for its own tasks.
- External events are never silently duplicated, deleted or overwritten.
- A task due date does **not** automatically create an external event.

Detailed semantics: `CALENDAR_SYNC.md`.

### 5.5 Sync (REQ-010)

- Server is authoritative for structured data; clients cache locally.
- Revision-aware writes; idempotent mutations; tombstones for deletes.
- Visible sync status: last success, connection state, pending changes, failures, conflicts.

### 5.6 Notifications (REQ-011)

- Tasks, scheduled blocks and calendar events can produce reminders.
- Backend owns scheduling and durable reminder state; delivery is platform-appropriate
  (Web Push for PWA, native push for mobile).
- No reminder for a cancelled entity; no duplicate delivery after retries; time-zone correct.
- **Amendment (ADR-0068, ACCEPTED by the owner 2026-11-04):** for the native clients "native push for mobile" is replaced by **device-local scheduling from synced reminder data** (desktop while the app runs; Android through OS alarms), plus an optional self-hosted UnifiedPush hint for instant sync; no FCM by default; iOS and macOS are out of scope (Q9). Desktop = Linux + Windows, plus Android. Home time zone, snooze presets (10 min, 1 h, 3 h, tomorrow morning), per-device enable toggle, no quiet hours by default, titles shown on lock screens with a setting to hide them: see ADR-0068.

### 5.7 UX

Primary navigation: Today, Inbox, Upcoming, Tasks, Projects, Calendar, Notes, Search, Settings.
Today is the landing page and stays simple. Quick capture requires a title only. Responsive,
keyboard-accessible, light/dark themes, useful empty states, clear errors, no decorative
clutter. Detailed in `ARCHITECTURE.md` §8.

### 5.8 Security, operations and portability (REQ-013, REQ-014, REQ-015)

- Maintained authentication; server-side authorisation on every protected operation.
- Secrets never committed; `.env.example` provides placeholders only.
- HTTPS for remote access; DB and worker ports never publicly exposed.
- Backups cover **both** PostgreSQL and the Markdown directory, with a tested restore.
- Full export of notes, tasks, projects and metadata in open formats.

Detailed controls: `SECURITY.md`. Backup/restore: `OPERATIONS.md`.

## 6. Non-Functional Requirements

- **Data integrity first.** No silent data loss under any failure mode.
- **Deterministic tests.** Unit, integration (real PostgreSQL), and end-to-end coverage as
  defined in `TESTING.md`.
- **Reproducible deployment.** One documented install via Docker Compose.
- **Observability.** Structured logs and health checks; no secrets or note content in logs.
- **Performance.** Interactive note open and task mutation on a typical home server; no
  speculative optimisation without evidence.

## 7. Assumptions and Open Questions

Assumptions recorded here are revisited when evidence changes:

- A1: A single household/personal deployment (small number of users) is the initial scale.
- A2: The server has a stable, optionally remote-accessible HTTPS endpoint.
- A3: Personal Google and personal/M365 Microsoft accounts are the primary calendar sources.

Open questions requiring validation during Milestone 0/5 are tracked in `DECISIONS.md`
(ADR-0006, ADR-0008) and `RISKS.md`. They do not block the planning gate.

## 8. Definition of Done (Release)

A first production-ready release must demonstrate all of:

- Markdown notes are genuine files and remain portable.
- Tasks and projects persist reliably.
- Google and Outlook calendars sync per the approved integration contract.
- Supported external edits propagate correctly.
- Cross-device changes converge without silent loss.
- Desktop and mobile workflows are usable.
- Notifications verified on supported platforms.
- Authentication and access control work.
- Backups can be restored (demonstrated, not merely documented).
- Install and upgrade are reproducible.
- No mandatory paid *application* service is required for the agreed feature set.
- Licensing permits intended personal and professional use.
- Docs describe actual behaviour and known limitations.
- Automated tests cover critical workflows.

If any mandatory requirement is unimplemented, the release is labelled accordingly.
