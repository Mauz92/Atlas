# Atlas — User Guide

**Status:** Delivered-feature guide
**Last updated:** 2026-11-02
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
| Markdown notes (create, autosaving editor, preview, rename, move, delete, tags, wiki links, search) | **Available** | Real `.md` files on disk — see [`MARKDOWN_STORAGE.md`](MARKDOWN_STORAGE.md). `[[` suggests notes; **Today's note** and templates (§4). |
| Tasks — capture, edit, Today, Inbox, Upcoming, the **Tasks** page with filters | **Available** | Open any task to edit title, dates, priority, tags, repeat, subtasks, reminder and linked notes; delete with undo. |
| Planning — Upcoming and Week views | **Available** | Later days and week-by-week work, in your local time zone. (The separate Day view was removed from navigation in UX-02; `/day` opens Today.) |
| Kanban board (move a task between statuses) | **Available** | Global board at **Board**; columns are the task statuses. |
| Projects and derived progress | **Available** | **Projects** page: create, edit, archive; each project has progress, tasks, a board and linked notes. |
| Search | **Available** | **Ctrl+K** finds notes, tasks and projects and runs commands; the **Search** page shows the same results. |
| Offline edits and cross-device sync | **Available** | A **Sync** page shows the queue, conflicts and a manual "Sync now". Edits made in the task and project screens need a connection. |
| Desktop notifications (Web Push) | **Partial** | Notification status is on **Settings**; **an operator must configure VAPID keys**, and a real delivery has not been verified on this install. |
| Reminder timing preferences | **Available** | Default timing on **Settings**; per-task override in the task panel. |
| Settings (account, theme, export, backup status, instance info) | **Available** | Change your name and password; download an export; see backup status and the version. |
| Calendar accounts (Google / Microsoft) and event views | **Not available** | Blocked on real provider accounts (`ROADMAP.md` M5/M6, AR-001). **Calendar** shows sync *status* only; Today's events area stays empty. |
| Mobile apps (Android / iOS) and native push | **Not available** | M8; needs real devices. The web app works on a phone-sized screen. |

Anything marked **Not available** or **Partial** does **not** exist as a working feature yet — the nav
item, if present, shows status only.

---

## 2. Getting started

### First run: create your account

On a fresh install, Atlas shows **Create your Atlas account**. This is the first (owner) account and
it owns the instance.

1. Enter a **Name**, an **Email** and a **Password** (at least 12 characters).
2. Select **Create account**. You are signed in and land on **Today**.

### Signing in and out

- Sign in with your **Email** and **Password** on the **Sign in to Atlas** screen.
- The bottom of the sidebar shows your name and a **Sign out** button (also in the palette: *Sign out*).

### Theme

Use the moon/sun button at the bottom of the sidebar, *Toggle theme* in the palette, or **Settings → Appearance**. Your choice is remembered
in this browser and follows your system preference until you change it.

### Keyboard shortcuts

Press **?** (when you are not typing in a field) or choose **Keyboard shortcuts** in the palette to see
them (also **Shortcuts** in the status bar). The main ones: **Ctrl/⌘ K** opens the palette, **Ctrl/⌘ B**
shows or hides the sidebar, **Esc** closes a panel or menu, **Enter** on a task opens it (the task panel saves
by itself; **Ctrl/⌘ Enter** just saves at once).
In task lists: **j**/**k** move, **x** completes (selects, on the Tasks page), **t** today, **m** project,
**p** priority (see *The views* below).

---

## 3. Finding your way around

The window has four parts (UX-02):

- **Rail** (far left): icons for **Today**, **Inbox**, **Tasks**, **Projects**, **Notes** and, at the bottom,
  **Settings**. The icon of the area you are in is highlighted.
- **Sidebar**: **Search** (opens the palette, Ctrl/⌘ K), then the sections **Planning** (Today, Inbox,
  Upcoming, Week), **Workspace** (Tasks, Board, Projects with your active projects, Notes) and **More**
  (Search page, Calendar, Sync, Notifications, Settings; collapsed until you open it). Select a section
  heading to fold it; Atlas remembers this in the browser. **Ctrl/⌘ B** hides or shows the whole sidebar.
  Your name, the theme button and **Sign out** are at the bottom.
- **Status bar** (bottom): sync state (*Synced*, *Offline · 3 queued*, *1 conflict*; select it to open
  **Sync**), the calendar's last sync (opens **Calendar**) and **Shortcuts**.
- **On a phone** (720 px wide or less): a bottom bar with Today, Inbox, Tasks, Projects and Notes; the
  menu button (top left) opens the sidebar as a drawer, and the search button (top right) opens the
  palette. The status bar only appears when something needs attention (offline, queued, conflicts).
  Between 721 and 1023 px the sidebar opens over the page from the rail's sidebar button.


| Page | Route | What it does today |
|---|---|---|
| **Today** | `/` | Landing page: overdue, due today, work scheduled today, today's note and quick capture. |
| **Inbox** | `/inbox` | Captured tasks waiting to be triaged; schedule, file or delete each (quick actions, the **…** menu or the keys **t**/**m**). |
| **Upcoming** | `/upcoming` | Tasks for later days, grouped by the day they are due. |
| *(Day)* | `/day` | Removed from navigation (ADR-0051); the address now opens **Today**. |
| **Week** | `/week` | The current week (Monday first), day by day. |
| **Tasks** | `/tasks` | Every task with filters, sort, saved filters and bulk actions. |
| **Board** | `/board` | Kanban board; drag a card (or use its status menu) to change status. |
| **Projects** | `/projects` | Your projects and each project's page. |
| **Calendar** | `/calendar` | Sync **status** for connected calendars only (no event views yet). |
| **Sync** | `/sync` | Offline queue, conflicts, and a manual "Sync now". |
| **Notifications** | `/notifications` | Notification permission and reminder timing (also on **Settings**). |
| **Notes** | `/notes` | The Markdown notebook (editor, preview, tree, search). |
| **Search** | `/search` | Search notes, tasks and projects. |
| **Settings** | `/settings` | Account, theme, reminders, export, backup status, instance info. |

---

## 4. Notes

Notes are ordinary UTF-8 Markdown files under the configured notes root. Atlas never requires itself
to read them — open the same files in any editor. Storage details, integrity rules and conflict
semantics are in [`MARKDOWN_STORAGE.md`](MARKDOWN_STORAGE.md).

**The workspace** — **Notes** has three parts: the file tree on the left, the open note in the middle and, on
the right, a details panel (**Links**, **Backlinks**, linked tasks and projects, tags). The panel opens and
closes with the panel button in the note header or **Ctrl/⌘ Alt B**, and Atlas remembers your choice (it
starts open on wide screens, and closed on a phone). On a phone the tree and the note take turns; the button
at the left of the note header brings the tree back. On a screen narrower than 1280 px the main sidebar tucks
away on this page to leave room (**Ctrl/⌘ B** or the rail's button still opens it).

**Open a note** — select a file in the tree. Turn on **Preview** in the note header to see the rendered note
beside the editor; `[[links]]` to other notes are clickable there.

**Create a note or folder** — the icons above the tree are **New note**, **New folder**, **New from template**
and **Today's note**. A name box appears in the tree in the folder you have open (select a folder to choose
another): type a name such as `Ideas` (or a path such as `Inbox/Ideas`; the `.md` ending is optional) and press
Enter. **New from template** lists the notes in `templates/`; choose one, then name the note. In a folder's **…**
menu, **New note here** and **New folder here** create inside that folder.

**Edit — there is no Save button.** Type; the note saves by itself about a second after you pause, and when
you switch to another note, rename, delete, create, leave the page or sign out. **Ctrl/⌘ S** just saves
immediately. The note header says what is happening: **Saving…**, **Saved**, **Not saved yet**, **Offline —
saved on this device**, **Couldn't save — kept on this device** (with **Retry**), **Not saved** (Atlas refused
the text; its message is shown) or **Conflict**. Hover the path to see the note's revision. Text you type is also
kept on this device until the server has it, so a crash, a closed tab or being offline does not lose it: open
the note again and the text is put back (and saved) with a short notice. Notes edited by another program or
device are never overwritten.

**Tags and wiki links** — write `#tag` and `[[Other note]]` directly in the note body. Tags and **Links** and
**Backlinks** are listed in the details panel. An unresolved wiki link is shown as such until a matching note
exists.

**Rename, move, delete** — use the note's **…** menu in the tree (**Rename** edits the name in place, **Move
to…** lists your folders, **Delete**) or the **…** in the note header (**Task from selection**, **Rename**,
**Delete**). Links that reference the note by its stable id survive the rename. Deleting asks first; the file
moves to the notes trash (`<notes-root>/.atlas/trash/…`) and a tombstone is recorded; it is never `rm`-ed, and
a file restored by hand is picked up again. A folder can be deleted only when it is empty.

**Resolve a conflict** — if the note changed elsewhere (for example, edited on disk or on another
device) while you had it open, the header shows **Conflict** and Atlas says *"Nothing was overwritten."* Your
text stays in the editor and nothing more is sent. Choose:

- **Keep my version as a copy** — your version is written next to the note as a conflict copy, and the
  current file is shown; and
- **Reload server version** — discard your local edit and load the current file.

The same appears if you open a note whose saved-on-this-device text was typed on an older version than the
one the server now has.

**Search notes** — use the **Search notes** box above the tree; matching notes are listed and open
on click.

---

## 5. Tasks

Tasks are captured with a **title only** and are organised by status. The statuses are
`inbox`, `next`, `in_progress`, `completed`, `archived`; Atlas enforces valid status transitions on
the server.

### Quick capture

Every list view (Today, Inbox) has a capture box: type a title and press **Add**. The task is created
immediately (on Today it is due today). Press **Enter** on a task title to open it and edit everything about
it.

### The task panel

Opening a task shows its panel: the title at the top (click it to edit), then its properties — **Status**,
**Priority**, **Due** (a date, and optionally a time; without a time it is due by the end of that day),
**Start**, **Time zone**, **Project** and **Tags** — then the description, **Repeat**, **Subtasks**,
**Reminder** and **Linked notes**. Click a value to change it: status, priority and project open a small menu;
the time zone opens a list you can search (type *tokyo*, press Enter); tags are added by typing and pressing
Enter or a comma, and removed with their ×.

**Everything saves by itself; there is no Save button.** A choice saves at once; text saves after a short pause
and whenever you leave the field, close the panel, open another task or leave the page. The top of the panel
says *Saving…*, *Saved*, *Offline — not saved* or *Conflict*:
- **Conflict** — the task was changed elsewhere (another tab or device) since you opened it. Nothing is
  overwritten and your values stay visible. **Load latest version** shows the newer version and keeps your
  changes aside; **Reapply my changes** saves them on top, **Dismiss** drops them.
- **Not saved** — Atlas rejected a value (for example an empty title); the reason is shown under the field and
  your text stays until you fix it.
- **Offline — not saved** — your changes stay in the panel and are saved when the connection is back. Task
  changes need a connection (they are not queued across a reload).
If you close the panel (or open another task) while something is not saved, Atlas asks whether to keep
editing or discard it.

On a wide screen (1280 px and up) the panel sits beside the list, so you can keep working in the list and open
another task with one click. On smaller screens it opens over the page (Esc or a click outside closes it), and
on a phone it fills the screen. **…** at the top has **Copy link** (opens this task on the Tasks page) and
**Delete task** (with **Undo**).

### The views

- **Today** — *Overdue*, *Due today*, *Scheduled today* (work that starts today), today's note and an
  events area that stays empty until calendars are connected. This is the landing page.
- **Inbox** — everything captured but not yet triaged (status `inbox`).
- **Upcoming** — tasks due on later days, grouped by day.
- **Week** — the seven days of the current week (Monday first), with week navigation. Empty days
  still render, so the week keeps a stable shape.

Each task row (UX-03) starts with a round **checkbox**: tick it to complete the task, untick a completed
task to reopen it (it goes back to *In progress*). Next come the title (select it, or press **Enter**, to open
the task) and, in grey, the parent task for a subtask (↳ *parent*), the project, the due date (amber when
overdue), the priority flag, subtask progress (`1/3`) and `#tags`. Completing a subtask never completes its
parent, and completing one occurrence of a recurring task never completes the series.

When you point at a row, or move into it with the keyboard, three quick actions appear: **Schedule for
today**, **Pick a date** and **Move to a project**. The **…** button at the end of every row opens the task
menu: *Today*, *Tomorrow*, *Next week* (the coming Monday), *Pick a date…*, *No date*, *Priority*, *Move to
project*, *Status* and *Delete* (with **Undo**). On a phone the quick actions are not shown; use **…**.
Giving an Inbox task a date or a project moves it out of the Inbox (to *Next*). A task that already has a
time keeps it when you move it to another day. A subtask always belongs to its parent's project, so it has no
project choice.

**Keyboard.** In any task list (when you are not typing in a field): **j** / **k** move to the next /
previous task, **Enter** opens it, **x** completes or reopens it, **t** schedules it for today, **m** opens the
project menu and **p** the priority menu. In a menu, use the arrow keys (or type the first letters), **Enter**
to choose and **Esc** to close. On the **Tasks** page, **x** selects the task for the bulk actions instead
(the square box before the round checkbox; it shows when you point at a row or once anything is selected).

### The board

On **Board**, the five columns are the task statuses. Move a task by **dragging** its card to another
column, or with **…** on the card → **Move to…** (the keyboard-accessible path; the same menu also schedules,
sets the priority, files to a project and deletes). Only transitions Atlas
allows are offered; a move the server rejects is reported on the page and the card is **not** moved.
Business rule and rationale: `ROADMAP.md` M4-03 (ADR-0022).

### What you cannot do from the UI yet

- Change a repeating task's rule or stop the series from an occurrence (the rule is shown read-only).
- Link an existing task to a note (a task links to a note when it is created from that note).
- Delete a project (you can archive it).
- Edit anything while offline: task and project changes need a connection (the task panel keeps unsaved
  changes until it is back online, but not across a reload); notes use the Sync page's queue.

---

## 6. Projects and planning

Open **Projects** to create a project, then open it for its description, **progress**, tasks (list or
board), linked notes, **Edit** and **Archive** / **Restore**. Active projects are also listed under
**Projects** in the sidebar. A task is filed in a project from its task panel (or from the Inbox's *File
to…*); a note is linked to a project from the note. **Week** shows a short **Projects** summary
with each project's progress.

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

Open **Settings** (or **Notifications**) for two things.

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

Open **Settings** for:

- **Account.** Change your **display name**. **Change password** asks for your current password and a new one
  of at least 12 characters; afterwards you stay signed in here and are **signed out everywhere else**. The
  email cannot be changed.
- **Appearance.** Light or Dark (remembered in this browser).
- **Reminders and notifications.** Notification status for this browser and the default reminder timing (§8).
- **Export your data.** **Download export** saves a zip with your notes (the real Markdown files), tasks and
  projects in open formats. It is for portability; it is not a backup.
- **Backups.** A read-only summary of the automatic backups: the last one, its size, the schedule and the last
  scheduled run. It cannot check the backup files themselves and says so; your operator can
  (`atlas-backup verify`, [`OPERATIONS.md`](OPERATIONS.md) §1). If the app cannot see the backup folder it tells
  you instead of saying there are no backups.
- **Instance.** The Atlas version, the environment, database status and schema revision.

---

## 11. Accessibility and troubleshooting

**Keyboard and accessibility.** Everything is reachable with the keyboard (**?** lists the shortcuts); the
board offers a non-drag path; errors are announced (`role="alert"`) and empty states are explicit. The pages
are checked automatically with axe-core in both themes; that is a partial check, not a full accessibility
audit.

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
