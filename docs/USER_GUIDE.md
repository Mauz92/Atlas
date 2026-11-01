# Atlas — User Guide

**Status:** Delivered-feature guide
**Last updated:** 2026-10-27
**Audience:** the person *using* Atlas (notes, tasks, planning, sync, notifications).

This guide describes **what Atlas does today** and how to use it. It is deliberately honest about
what is not finished yet — see [What's in this release](#whats-in-this-release-and-what-isnt) and the
canonical milestone status in [`ROADMAP.md`](ROADMAP.md). Where a topic has its own authoritative
document (Markdown semantics, storage, security), this guide links to it rather than restating it.

> Atlas is self-hosted. To run it, or if the app will not start, see the
> [`OPERATOR_GUIDE.md`](OPERATOR_GUIDE.md).

---

## 1. What's in this release (and what isn't)

Atlas is being built milestone by milestone. This table is the honest state of each user-facing area;
`DONE`/`IN PROGRESS`/`BLOCKED` follow [`ROADMAP.md`](ROADMAP.md).

| Area | State | Notes |
|---|---|---|
| Markdown notes (create, edit, preview, rename, delete, tags, wiki links, search) | **Available** | Real `.md` files on disk — see [`MARKDOWN_STORAGE.md`](MARKDOWN_STORAGE.md). |
| Tasks — quick capture, Today, Inbox, Upcoming | **Available** | Title-only capture; complete a task from any list. |
| Planning — Day and Week views | **Available** | Day-by-day / week-by-week work, in your local time zone. |
| Kanban board (move a task between statuses) | **Available** | Global board at **Board**; columns are the task statuses. |
| Projects and derived progress | **Partial** | Stored and calculated by the server and shown as context in Day/Week; **no Projects page** yet (see below). |
| Search and filters | **Partial** | Note search works inside **Notes**; task filters/search exist only through the API — **no Search page** yet. |
| Offline edits and cross-device sync | **Available** | A **Sync** page shows the queue, conflicts and a manual "Sync now". |
| Desktop notifications (Web Push) | **Partial** | The **Notifications** page can register this browser; **an operator must configure VAPID keys**, and a real delivery has not been verified on this install. |
| Reminder timing preferences | **Available** | Default timing on **Notifications**; per-task override is API-only for now. |
| Calendar accounts (Google / Microsoft) and event views | **Not available** | Blocked on real provider accounts (`ROADMAP.md` M5/M6, AR-001). **Calendar** shows sync *status* only. |
| Mobile apps (Android / iOS) and native push | **Not available** | M8; needs real devices. |
| Settings, Projects, Tasks, Search pages | **Not available** | These nav items open a placeholder screen. |

Anything marked **Not available** or **Partial** does **not** exist as a working feature yet — the nav
item, if present, is a placeholder or shows status only.

---

## 2. Getting started

### First run: create your account

On a fresh install, Atlas shows **Create your Atlas account**. This is the first (owner) account and
it owns the instance.

1. Enter a **Name**, an **Email** and a **Password** (at least 12 characters).
2. Select **Create account**. You are signed in and land on **Today**.

### Signing in and out

- Sign in with your **Email** and **Password** on the **Sign in to Atlas** screen.
- The top bar shows your name and a **Sign out** button.

### Theme

Use the **Dark / Light** button in the top bar to switch themes. Your choice is remembered in this
browser and follows your system preference until you change it.

---

## 3. Finding your way around

The left sidebar is the main navigation. Some entries are placeholders today:

| Nav item | Route | What it does today |
|---|---|---|
| **Today** | `/` | Landing page: overdue and due-today tasks, with quick capture. |
| **Inbox** | `/inbox` | Captured tasks waiting to be triaged, with quick capture. |
| **Upcoming** | `/upcoming` | Tasks for later days, grouped by the day they are due. |
| **Day** | `/day` | One day at a time, with day navigation. |
| **Week** | `/week` | The current week (Monday first), day by day. |
| **Tasks** | `/tasks` | **Placeholder** — a filterable task list is not built yet. |
| **Board** | `/board` | Kanban board; drag a card (or use its status menu) to change status. |
| **Projects** | `/projects` | **Placeholder** — no project page yet. |
| **Calendar** | `/calendar` | Sync **status** for connected calendars only (no event views yet). |
| **Sync** | `/sync` | Offline queue, conflicts, and a manual "Sync now". |
| **Notifications** | `/notifications` | Turn desktop notifications on/off; set reminder timing. |
| **Notes** | `/notes` | The Markdown notebook (editor, preview, tree, search). |
| **Search** | `/search` | **Placeholder** — use search inside **Notes**. |
| **Settings** | `/settings` | **Placeholder** — theme lives in the top bar. |

---

## 4. Notes

Notes are ordinary UTF-8 Markdown files under the configured notes root. Atlas never requires itself
to read them — open the same files in any editor. Storage details, integrity rules and conflict
semantics are in [`MARKDOWN_STORAGE.md`](MARKDOWN_STORAGE.md).

**Open a note** — go to **Notes** and select a file in the tree on the left. The editor (source) and a
rendered **preview** are shown side by side.

**Create a note or folder**

1. In the left panel's path box, type a path such as `Inbox/New note` (a `.md` extension is optional).
2. Select **New note** (starts from a heading) or **New folder**.

**Edit and save** — type in the editor; **Save** is enabled while there are unsaved changes. The
toolbar shows the note's path and its current **revision**.

**Tags and wiki links** — write `#tag` and `[[Other note]]` directly in the note body. Tags appear
under the editor; **Links** and **Backlinks** are listed below. An unresolved wiki link is shown as
such until a matching note exists.

**Rename** — select **Rename** and enter the new path. Links that reference the note by its stable id
survive the rename.

**Delete** — select **Delete**. The file moves to the notes trash (`<notes-root>/.atlas/trash/…`) and
a tombstone is recorded; it is never `rm`-ed, and a file restored by hand is picked up again.

**Resolve a conflict** — if the note changed elsewhere (for example, edited on disk or on another
device) while you had it open, saving is refused and Atlas shows *"This note changed elsewhere."*
Nothing is overwritten. Choose:

- **Keep my version as a copy** — your version is written next to the note as a conflict copy; and
- **Reload server version** — discard your local edit and load the current file.

**Search notes** — use the **Search notes** box in the left panel; matching notes are listed and open
on click.

---

## 5. Tasks

Tasks are captured with a **title only** and are organised by status. The statuses are
`inbox`, `next`, `in_progress`, `completed`, `archived`; Atlas enforces valid status transitions on
the server.

### Quick capture

Every list view (Today, Inbox) has a capture box: type a title and press **Add**. The task is created
immediately.

### The views

- **Today** — overdue work carried forward plus what is due today, split into *Overdue* and *Due
  today*. This is the landing page.
- **Inbox** — everything captured but not yet triaged (status `inbox`).
- **Upcoming** — tasks due on later days, grouped by day.
- **Day** — one day at a time, with **Previous day / Today / Next day**. Today's page reuses the
  server's *today* classification; other days show what is due that day.
- **Week** — the seven days of the current week (Monday first), with week navigation. Empty days
  still render, so the week keeps a stable shape.

Each task row shows its title and, when present, its priority, project tag, subtask progress and due
time. Use **Complete** to mark a task done; the list refreshes. Completing a subtask never completes
its parent, and completing one occurrence of a recurring task never completes the series.

### The board

On **Board**, the five columns are the task statuses. Move a task by **dragging** its card to another
column, or with the card's **status menu** (the keyboard-accessible path). Only transitions Atlas
allows are offered; a move the server rejects is reported on the page and the card is **not** moved.
Business rule and rationale: `ROADMAP.md` M4-03 (ADR-0022).

### What you cannot do from the UI yet

The task API supports far more than the current screens expose. The following are **not** in the web
UI yet and need the API (see [`ARCHITECTURE.md`](ARCHITECTURE.md) / the OpenAPI docs):

- Editing a task's title, due date, priority, recurrence, subtasks or notes.
- Creating tasks with a due date, priority or recurrence (capture is title-only).
- The full task list with **filters** (status, priority, date range, project) and text **search**.
- Per-task reminder timing overrides (the *default* is in the UI; see §8).

---

## 6. Projects and planning

Projects, their task membership and a **derived progress** figure are implemented on the server and
covered by tests, but there is **no Projects page yet**, so you cannot create or manage a project from
the web UI in this release. Project support exists through the API and is surfaced where it helps:

- A task that belongs to a project shows a **project tag** in the planning views.
- **Day** and **Week** show a short **Projects** summary naming the projects the plan touches, each
  with its derived progress.

**How project progress is calculated** (canonical in [`PRODUCT_SPEC.md`](PRODUCT_SPEC.md) §5.3,
ADR-0023): `total` = the project's live, non-`archived` tasks; `completed` = those whose status is
`completed`; the figure is `round(completed × 100 / total)` to the nearest whole percent, and **0**
when there are no countable tasks (a project with no countable tasks is not "complete"). Soft-deleted
and `archived` tasks, and tasks filed elsewhere, never count.

---

## 7. Sync, offline and the Sync page

Atlas keeps your data on the server and lets you keep working when the connection drops. Changes you
make offline are **stored on this device** and sent automatically when the connection returns. This
applies to the editing operations the current UI performs.

Open **Sync** to see:

- an overall **state** badge — *up to date / syncing / offline / error / conflicts*;
- the **pending**, **failed** and **conflict** counts, and the queued operations;
- **Sync now**, which flushes the queue and pulls missed changes.

**Conflicts.** If an item changed on the server while your edit was waiting, your edit is **kept** (not
discarded) and shown as a conflict. Resolve it per item:

- **Keep mine** — re-send your edit against the server's current revision.
- **Take server** — discard your local edit and adopt the server's version.

Atlas never silently overwrites a newer change. If the server tells the client to resynchronise (for
example, a device has been offline longer than the retained change history), Atlas does a full resync
and resumes cleanly. Reasoning: `ROADMAP.md` M7 (ADR-0032…ADR-0036).

---

## 8. Notifications and reminders

Open **Notifications** for two things.

**Turn desktop notifications on.** Select **Enable notifications** to allow this browser to show a
reminder when it is due — even when the Atlas tab is closed. Atlas reports the state explicitly:
*Unsupported* (this browser cannot), *Unavailable* (the server has no push keys — ask your operator),
*Blocked* (you turned Atlas off in the browser's site settings), *Off*, *Allowed*, or *On*. Select
**Turn off notifications** to stop.

> Delivery goes through your browser's push service (Web Push). **An operator must configure VAPID
> keys on the server**, and real delivery has not been verified on this install — see
> [`OPERATOR_GUIDE.md`](OPERATOR_GUIDE.md) and the note in [`ROADMAP.md`](ROADMAP.md) (M8).

**Set reminder timing.** Under *Reminder timing*, choose when Atlas should remind you before a task is
due — *No reminder*, *On the due day at 09:00*, *1 / 2 days before at 09:00*, *1 week before at
09:00*, or **Custom…** (whole days before, from 0 to 30, at a 24-hour `HH:MM`). This default applies to
tasks that have no timing of their own. A per-task override is available through the API but not in the
UI yet.

---

## 9. Calendar

The **Calendar** page is a **status surface only** in this release: per provider it shows whether the
account is connected, the last successful sync, the derived state and any error, with a manual
**Sync now**.

**There is no way to connect a Google or Microsoft account yet, and no day/week/month event view.**
Those steps (milestone M5/M6) are blocked on real provider accounts (AR-001); until then the page
reads *"No calendar accounts are connected yet."* Design and semantics for when it lands:
[`CALENDAR_SYNC.md`](CALENDAR_SYNC.md).

A task's due date never creates a calendar event automatically — task deadlines and external events
are separate concepts (`CALENDAR_SYNC.md` §7).

---

## 10. Settings, themes and data portability

- **Settings** is a placeholder; there is no account or connection settings page yet.
- **Theme** (light/dark) is the top-bar toggle (§2).
- **Data portability.** Your notes are already plain Markdown on disk. A complete export of your
  notes, tasks and projects (as open formats) is implemented on the server-side as
  `GET /api/export` (a zip) and the operator `atlas-export` command — **there is no in-app "Export"
  button in this release**. See [`OPERATIONS.md`](OPERATIONS.md) §1.3.

---

## 11. Accessibility and troubleshooting

**Keyboard and accessibility.** Navigation, capture, the board's status menu, the sync and
notification controls are keyboard-focusable buttons, selects and inputs; the board offers a
non-drag path; errors are announced (`role="alert"`) and empty states are explicit.

**Common questions**

| Symptom | What to do |
|---|---|
| "This note changed elsewhere." | A newer version exists. **Keep my version as a copy** or **Reload server version** (§4). |
| A conflict is listed on **Sync** | Resolve it with **Keep mine** or **Take server** (§7). |
| Notifications say *Unavailable* | The server has no VAPID keys; ask your operator (§8, [`OPERATOR_GUIDE.md`](OPERATOR_GUIDE.md)). |
| Notifications say *Blocked* | Re-enable Atlas in your browser's site/notification settings, then reload. |
| A task move is rejected on **Board** | That status change is not allowed by Atlas; the card stays put and the reason is shown. |
| **Calendar** shows "never synced" | No account is connected; calendar accounts are not available yet (§9). |
| An edit is stuck pending on **Sync** | You may be offline; select **Sync now** when the connection returns. |

---

## 12. Related documents

- [`README.md`](../README.md) — project overview.
- [`OPERATOR_GUIDE.md`](OPERATOR_GUIDE.md) — install, configure, back up, restore, upgrade, monitor.
- [`PRODUCT_SPEC.md`](PRODUCT_SPEC.md) — what Atlas is meant to do (requirements).
- [`MARKDOWN_STORAGE.md`](MARKDOWN_STORAGE.md) — notes storage, revisions, conflicts.
- [`CALENDAR_SYNC.md`](CALENDAR_SYNC.md) — calendar semantics (not yet user-facing).
- [`ROADMAP.md`](ROADMAP.md) — milestone status (what is done, in progress or blocked).
- [`CHANGELOG.md`](CHANGELOG.md) — user-visible changes per release.
