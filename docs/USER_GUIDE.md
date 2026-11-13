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
| Kanban board (move a task between statuses) | **Available** | Each project's **Board** tab (there is no separate Board page: a task with no project is on no board); drag, the card menu or **]** / **[**. |
| Projects and derived progress | **Available** | **Projects** page: create, edit, archive; each project has progress, tasks, a board and linked notes. |
| Search | **Available** | **Ctrl+K** finds notes, tasks and projects and runs commands; the **Search** page shows the same results. |
| Offline edits and cross-device sync | **Available** | **Settings → Sync** shows the queue, conflicts and a manual "Sync now". Edits made in the task and project screens need a connection. |
| Desktop notifications (Web Push) | **Partial** | Notification status is in **Settings → Notifications and reminders**; **an operator must configure VAPID keys**, and a real delivery has not been verified on this install. |
| Reminder timing preferences | **Available** | Default timing in **Settings → Notifications and reminders**; per-task override in the task panel. |
| Settings (account, appearance, notifications, calendar, sync, data and backups, about) | **Available** | A list of sections with one open at a time: change your name and password; pick a theme; download an export; see backup status and the version. |
| Calendar accounts (Google / Microsoft) and event views | **Not available** | Blocked on real provider accounts (`ROADMAP.md` M5/M6, AR-001). **Settings → Calendar** shows sync *status* only; Today's events area stays empty. |
| Mobile apps (Android / iOS) and native push | **Not available** | M8; needs real devices. The web app works on a phone-sized screen. |

Anything marked **Not available** or **Partial** does **not** exist as a working feature yet — the nav
item, if present, shows status only.

---

## 2. Getting started

### First run: create your account

On a fresh install, Atlas shows **Create your Atlas account**. This is the first (owner) account and
it owns the instance.

1. Enter a **Name**, an **Email** and a **Password** (at least 12 characters).
2. Select **Create account**. Atlas now shows your **recovery code** (six groups of five letters and digits). **This is the only time it is
   shown.** Use **Copy code** or **Download as file**, keep it somewhere private and safe (a password manager is ideal; not in your notes
   folder or a synced note), tick **I have saved my recovery code** and select **Continue to Atlas**. You land on **Today**.
   The code is what lets you set a new password if you ever forget it. If you did not save it, make a new one in **Settings → Account**.

### Signing in and out

- Sign in with your **Email** and **Password** on the **Sign in to Atlas** screen.
- **Forgot your password?** Select **Forgot password?** under the sign-in form. Enter your email, your **recovery code** (capitals, dashes and
  spaces do not matter) and a new password twice. It signs you out **everywhere** (every browser and every desktop or phone app) and shows
  a **new recovery code once**: your old one no longer works, so save the new one as you did the first (tick **I have saved my recovery code**).
  Then sign in with the new password. If the message says the email and code do not match, check both; it never says which one was wrong.
  After several wrong tries you must wait a few minutes. If you lost the code too, whoever runs your server can reset the password from the
  server's command line (`atlas-admin reset-password`).
- The bottom of the sidebar shows your name and a **Sign out** button (also in the palette: *Sign out*).

### Theme

Use the moon/sun button at the bottom of the sidebar, *Toggle theme* in the palette, or **Settings → Appearance**. Your choice is remembered
in this browser and follows your system preference until you change it.

### Accent colour

**Settings → Appearance → Accent colour** lets you pick the colour used for buttons, links, the selected item in the menus and
the focus outline: Neutral (the default, black and white), Blue, Indigo, Violet, Pink, Red, Orange, Amber, Green or Teal. The page changes as soon as you pick
one (a sample heading shows the effect), and it works with Light, Dark and System. With an accent chosen, **Colour headings with the accent** (on by default; it does nothing for Neutral) also colours page titles,
section headings, the sidebar's group names and the headings in your notes; body text, task titles and labels stay neutral. Colours that carry meaning (overdue, due today, priority, the project dots and
your calendar colours) never change with the accent. The choice is remembered in this browser only: set it again on each browser or desktop app
you use (syncing it across devices is a possible later option).

### Keyboard shortcuts

Press **?** (when you are not typing in a field) or choose **Keyboard shortcuts** in the palette to see
them (also **Shortcuts** in the status bar). The main ones: **Ctrl/⌘ K** opens the palette, **Ctrl/⌘ B**
shows or hides the sidebar, **Esc** closes a panel or menu, **Enter** on a task opens it (the task panel saves
by itself; **Ctrl/⌘ Enter** just saves at once).
In task lists: **j**/**k** move, **x** completes (selects, on the Tasks page), **t** today, **m** project,
**p** priority (see *The views* below). On a board card: **]** / **[** move it to the next / previous column.

---

## 3. Finding your way around

The window has four parts (UX-02):

- **Rail** (far left): icons for **Today**, **Inbox**, **Tasks**, **Projects**, **Notes** and, at the bottom,
  **Settings**. The icon of the area you are in is highlighted.
- **Sidebar**: **Search** (opens the palette, Ctrl/⌘ K), then the sections **Planning** (Today, Inbox,
  Upcoming, Week), **Workspace** (Tasks, Projects with your active projects, Notes) and **More**
  (Search page and Settings; collapsed until you open it). Select a section
  heading to fold it; Atlas remembers this in the browser. **Ctrl/⌘ B** hides or shows the whole sidebar.
  Your name, the theme button and **Sign out** are at the bottom.
- **Status bar** (bottom): sync state (*Synced*, *Offline · 3 queued*, *1 conflict*; select it to open
  **Settings → Sync**), the calendar's last sync (opens **Settings → Calendar**) and **Shortcuts**.
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
| **Tasks** | `/tasks` | Every task: a filter bar (search, Status, Priority, Project, Due, Sort), saved views and bulk actions. |
| **Projects** | `/projects` | Your projects (progress, open tasks, target date) and each project's page (Tasks, Board, Notes tabs). |
| **Notes** | `/notes` | The Markdown notebook (editor, preview, tree, search). |
| **Search** | `/search` | Search notes, tasks and projects. |
| **Settings** | `/settings` | A section list and one section at a time, in the address (`/settings/account`, `/appearance`, `/notifications`, `/calendar`, `/sync`, `/data`, `/about`). **Account:** name and password. **Appearance:** theme and accent colour. **Notifications and reminders:** desktop notifications and default reminder timing. **Calendar:** sync status for connected calendars (no event views yet). **Sync:** offline queue, conflicts and "Sync now". **Data and backups:** export and backup status. **About:** version and instance health. The old `/sync`, `/notifications` and `/calendar` addresses still work and open their section. On a phone the list comes first and each section opens with an **All settings** link back. |

**Reading a task row.** Line 1 is the title (tap it, or anywhere in the row, to open the task). Line 2 says when and how important:
a red **Overdue** chip with a warning icon, a blue **Today** chip with a sun, otherwise the date (or just the time under a day
heading such as Upcoming's "Tomorrow"), then a flag with **Urgent** or **High** (Medium and Low show the flag only on a phone) and
the subtask count. Line 3 shows the project (with its colour dot; the colour is picked for you from the project, not chosen) and
up to two tags, with "+n" for more. The round box completes the task; **...** opens its menu. Section headers stay at the top of
the screen while you scroll their list and show how many tasks they hold.

While a list is loading, Atlas shows grey placeholder rows instead of text (they stop shimmering if your system asks for reduced motion). An empty list says what is missing: *Inbox zero*, *Nothing is due today*, *No projects yet*, *No tasks match these filters* and so on, with one button where one helps (for example **Go to Inbox** on an empty Tasks page).

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

**Source and Live** — the **Source | Live** switch in the note header chooses how the editor shows the text; Atlas
remembers it in this browser and starts in **Live**. **Source** shows the Markdown exactly as typed. **Live**
hides the Markdown marks on every line except the one your cursor is on (or the lines you have selected), so
headings look like headings, `**bold**` looks bold, and `- [ ]` lines are checkboxes. It is only a display: the
file holds the same text in both modes, undo works across a switch, and your cursor stays where it was.
- Click a checkbox to tick it (the text changes from `[ ]` to `[x]`), or press **Ctrl/⌘ Enter** on the line.
- Click a `[[wiki link]]` to open that note (**Ctrl/⌘ click** when the line is the one you are editing). A link to
  a note that does not exist yet is dashed and does nothing.
- A web link (`[words](https://…)`) opens in a new tab with **Ctrl/⌘ click** (or **Ctrl/⌘ Enter** inside it). Only
  `http`, `https` and `mailto` addresses open; anything else (such as `javascript:`) is ignored.
- Images are not loaded in either mode (Atlas never fetches a URL a note contains); HTML in a note is shown as
  text, not run. Tables and ordered-list numbers appear as the Markdown you wrote.
- Press **Ctrl/⌘ Enter** to tick or open from the keyboard; checkboxes are not tab stops so Tab does not step
  through a long list.

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

On a computer or tablet, Today, Inbox and a project have a capture box: type a title and press **Add**. The task is
created immediately (on Today it is due today). On a **phone** (a narrow window) a round **+** button ("Capture a task")
floats above the bottom bar on Today, Inbox, Upcoming, Week, Tasks and a project; tap it, type a title and press **Add**. The sheet
stays open so you can add several tasks, and says where each went: Today's go to Today, a project's to that project, the others to
the Inbox. **Close** or **Esc** closes it. Press **Enter** on a task title to open it and edit everything about it.

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
- **Week** — the seven days of the current week (Monday first) as day cards that fit your window (one column on a phone,
  two or more on a wider screen, never sideways scrolling). Today's card is highlighted; a day with nothing on it is one
  quiet line. Use **Previous week / This week / Next week** (the arrows on a phone) to move; **Projects** shows the
  projects the week touches (tap it on a phone to expand).

On a phone (or any touch screen without hover) the **…** menu of a task opens as a **sheet from the bottom** with large items and
a **Cancel**; tap outside it, press **Esc** or choose **Cancel** to close it. On a computer it stays a small popup.

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

### The Tasks page

One bar holds the filters: a **Search** box and the chips **Status**, **Priority**, **Project**, **Due** and
**Sort** (click a chip, or focus it and press Enter, and choose; **Due** also takes a from / to date or a preset
such as *Next 7 days*). A chip shows its value once it differs from the default; **Reset filters** clears all of
them. The address of the page is the view, so you can bookmark or share it. In the **…** menu at the end of the
bar, **Save this view…** keeps the current filters under a name in this browser, and **Saved views** applies or
removes one.

**On a phone** the chips are one **Filters** button (it shows how many filters are set) that opens the same
choices as a sheet; **Reset filters** is in it. The select boxes are hidden until you choose **…** →
**Select tasks**: then each row has one box instead of the round completion box, **Select all** and **Done**
appear, and **Done** leaves the mode. A Medium or Low priority shows its word on a phone.

Tick the square box in front of tasks (or press **x**) to select them: a bar floats at the bottom with
**Complete selected**, **Move to project…**, **Delete selected** (with **Undo**) and **Clear selection**.

### The board

On a project's **Board** tab (there is no separate Board page since UX-11; an old `/board` link opens **Projects**,
and a task with no project is on no board), the columns are the task statuses; the
**Archived** column is hidden until you choose **Show archived**. Move a task by **dragging** its card to another
column, with **…** on the card → **Move to…**, or, with the card focused, with **]** (next column) and **[**
(previous column), which skip moves Atlas does not allow; the card keeps keyboard focus. The same **…** menu also
schedules, sets the priority, files to a project and deletes. Only transitions Atlas
allows are offered; a move the server rejects is reported on the page and the card is **not** moved.
On a phone the board shows **one column at a time**: choose it from the tab strip (each tab shows its count), **…** →
**Move to…** moves a card, and **?** explains the board. Business rule and rationale: `ROADMAP.md` M4-03 (ADR-0022), ADR-0064.

### On a phone: Notes and the palette

In **Notes** the toolbar shows the note's name and folder, its save state, one **Source | Live | Preview**
switch and **…** (links and details, task from selection, rename, delete); **Show notes list** goes back to the
tree. The command palette (the search button in the header) fills the screen, has a **Close** button and no
keyboard hints.

### What you cannot do from the UI yet

- Change a repeating task's rule or stop the series from an occurrence (the rule is shown read-only).
- Link an existing task to a note (a task links to a note when it is created from that note).
- Delete a project (you can archive it).
- Edit anything while offline: task and project changes need a connection (the task panel keeps unsaved
  changes until it is back online, but not across a reload); notes use the Sync page's queue.

---

## 6. Projects and planning

Open **Projects** to create a project. Each row shows its **progress**, how many tasks are open, its target
date and a **…** menu (**Open project**, **Archive project** / **Restore project**); archived projects are
behind **Show archived**. A project's page has its name, status, progress and dates at the top, a **…** menu
(**Edit project**, **Archive** / **Restore**) and three tabs: **Tasks** (open tasks, with finished ones folded
into **Completed (n)** and **Archived (n)**), **Board** and **Notes** (linked notes). Active projects are also listed under
**Projects** in the sidebar. On a phone each project is a card (colour dot, progress bar, a one-line summary and
the target date; tap the card to open it). A task is filed in a project from its task panel (or from the Inbox's *File
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

Open **Settings → Sync** to see:

- an overall **state** badge — *up to date / syncing / offline / error / conflicts*;
- the **pending**, **failed** and **conflict** counts, and the queued operations;
- **Sync now**, which flushes the queue and pulls missed changes.

**Conflicts.** If an item changed on the server while your edit was waiting, your edit is **kept** (not
discarded) and shown as a conflict. Resolve it per item:

- **Keep mine** — re-send your edit against the server's current revision.
- **Take server** — discard your local edit and adopt the server's version.

**Changes from other devices (new, SYNC-11).** When two devices change the same thing at the same time, the server keeps one result and
records the decision. A banner at the top of the page says **"Changed on another device"** with a **Review** button; the page it opens
(**Settings → Sync → Changes from other devices**, `/changes`) lists the decisions, newest first, with what changed, on which device (a device
the browser cannot name reads "another device" in the desktop app), when, and the value that was replaced (only simple fields such as status,
priority, due date or note location; never your text). **Undo** puts the replaced value back, but only if nothing changed it since. If it did,
Atlas says **"Not undone: the priority was changed again since"**; that is normal on a busy field, nothing was overwritten, and you can set the
value yourself. Some decisions cannot be undone in one step (a note edit that was merged, an edit that brought back a deleted item, a note that was
renamed because its name was taken); the entry says why and links to the item. Entries are kept for 90 days.

**Two versions of a text.** If you edit the **title or description** of a task while another device changed it, the task panel says it
*changed somewhere else*; **Load latest version** shows the new text and, for each text field you had edited, **both versions side by side** with
**Keep mine**, **Keep theirs** or **Edit merged** (one box holding both texts). Nothing is saved until you choose; your choice is saved like any other edit,
so a newer change still asks again instead of being overwritten. For notes, when the server could not merge two edits it saves the other one as a
**conflict copy** next to the note (`name (conflict ... ).md`); the **Notes** page then shows "N notes have two versions" with **Resolve**: a line-by-line
comparison, then **Keep mine**, **Keep theirs** or **Merge in the editor**. The conflict copy is moved to the trash only after the note itself was saved.

**After a server restore (desktop app).** If your administrator restored the server from a backup, the desktop app stops syncing and shows
**"The server was restored from a backup"** with what it knows (how far this computer had seen, how many changes are unsent). It never decides for you:
**Re-upload my local data** adds back what the server lost (same ids, nothing already there is changed); **Discard local changes and re-download**
drops the unsent changes on this computer and takes the server's data (it asks a second time; files in your notes folder are never deleted, a file
the server does not have is added again as a new note). Another full-screen explanation appears when the app is too old for the server (**Atlas needs to be updated**)
and when the device was signed out (**Sign in again**; nothing on the computer is deleted).

**Instant updates (Settings → Notifications and reminders, and Settings → Desktop app).** Shows whether this browser can show notifications, whether
they are allowed, a **Show a test notification** button (it only tests this device; it does not send anything through the server), and, in the desktop app,
whether the live connection is up, when the last "something changed" hint arrived and whether the server has a push gateway configured (used by the Android app only).

Atlas never silently overwrites a newer change. If the server tells the client to resynchronise (for
example, a device has been offline longer than the retained change history), Atlas does a full resync
and resumes cleanly. Reasoning: `ROADMAP.md` M7 (ADR-0032…ADR-0036).

---

## 8. Notifications and reminders

Open **Settings → Notifications and reminders** for two things.

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

**Read-only.** Atlas shows your events; it never creates, edits or deletes anything at Google, Microsoft or Proton.
Live behaviour with real accounts has not been verified yet (see `CALENDAR_SYNC.md` section 12.7 for the check the
owner runs once).

**Connect.** Settings -> Calendar has three cards. *Google Calendar* and *Microsoft Outlook* show **Connect** once the
server owner has entered the provider's client id and secret ([setup guide](CALENDAR_SYNC.md), section 12); until
then the card explains what is missing and shows the exact redirect address to register. You sign in at the provider
(Atlas never sees your password), allow read access to your calendars, and return to Settings. Then tick the
calendars to show and pick a colour for each. **Sync now** refreshes; **Disconnect** asks first and deletes Atlas's
copy of the events (your real calendar is untouched; reconnecting syncs again).

**ProtonMail and other feeds.** In Proton Calendar choose *Share via link*, create a view-only link, copy it, then in
Atlas use *Add a calendar feed (ICS)*: paste the link, name it, **Test feed** (shows how many events it holds) and
**Add feed**. The link is a secret: Atlas stores it encrypted and shows only the host afterwards; to revoke it,
create a new link in Proton and replace the feed. Proton updates its feeds slowly, so changes can take hours to show.

**The Calendar page** (sidebar -> Calendar): Day, Week, Month and Agenda; previous / Today / next; times are shown in
your time zone (the event's own zone is on its detail); all-day and multi-day events sit in their own row;
overlapping events sit side by side; recurring events are expanded. Click an event for its details and an
"Open in ..." link. Keyboard: left/right arrows move, `t` is today, `d` `w` `m` `a` switch views. On a phone the
Agenda is the default. **Today** and **Week** list the day's events in a separate **Events** section; a task's due
date never becomes a calendar event.

**If something is wrong.** A card saying *Needs re-authorisation* means the provider stopped accepting the saved
sign-in: press **Reconnect**. A feed saying *link rejected* means the link was revoked: add the new one. See the
troubleshooting table in [`CALENDAR_SYNC.md`](CALENDAR_SYNC.md) section 12.6.

### Importing a calendar file (.ics)

For a calendar that gives you no link: export it as an **.ics** file (Google Calendar, Outlook, Apple Calendar and Proton can all do this), then in **Settings > Calendar > Import a calendar file** choose the file, give it a name and press **Check file** (it tells you how many events it holds; nothing is saved yet) and then **Import**. The events appear read-only in Today and Calendar, in the colour you chose. An imported file is **not refreshed**: when the calendar changes, export it again and use **Replace file** on that calendar (events that are no longer in the file disappear, changed ones update). **Remove** deletes the calendar and its events from Atlas; your original calendar and file are not touched. Limits: 5 MiB per file, 20 calendars in total (links and files together).

## 10. Settings, themes and data portability

Open **Settings** for:

- **Account.** Change your **display name**. **Change password** asks for your current password and a new one
  of at least 12 characters; afterwards you stay signed in here and are **signed out in your other browsers**.
  Your desktop and phone apps keep syncing unless you tick **Also sign out my devices** (tick it if you think the old
  password was exposed). The email cannot be changed. **Recovery code** shows whether a code is set, when it was made and when it was last
  used. **Regenerate** (or **Create recovery code** on an account that has none) asks for your current password, makes a new code and shows it
  once; the old code stops working at once. If your server's operator turned recovery off, the row says so.
- **Devices.** The desktop and phone apps that sync with this server (coming in a later release; the list is empty until
  one signs in). Each app signs in once with your email and password and then holds its own key, which is never shown
  here. For every device you see its name, platform and when it last connected; **Rename** it, or **Sign out** a lost or
  retired one (it stops syncing at its very next request and asks for your password; what is already on it stays there).
  **Sign out all devices** ends them all. Browsers are not listed: they end when you sign out or change your password.
- **Appearance.** Theme (System, Light or Dark) and **Accent colour** (Neutral by default, or one of nine colours); both are remembered in this browser only.
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
| A task move is rejected on a project's **Board** | That status change is not allowed by Atlas; the card stays put and the reason is shown. |
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


## Home time zone for reminders (new, M8-04a)

**Settings -> Notifications -> Home time zone.** Reminder times such as "09:00" are read in the time zone of the task. A task without one used to be read in UTC; it now uses your home time zone. Atlas fills it in from your browser the first time you sign in; change it here if you moved or want another zone. "Not set (UTC)" keeps the old behaviour. Changing it recomputes the reminders of tasks that have no zone of their own; reminders that were already delivered are not repeated.

Known limits of the coming device reminders (ADR-0068): the desktop app must be running (it can stay in the tray); a task created or re-dated while offline gets its reminder only after the next sync; every device you enable rings, and dismissing on one clears the others after their next sync.


## Atlas desktop app for Linux (new, SYNC-09 phase 1)

**What it is.** A desktop app that keeps your notes as ordinary Markdown files in a folder on your computer, syncs them (and your tasks and reminders) with your own Atlas server,
and shows the same Atlas screens you know from the browser. It works as a normal window and also lives in the **tray**. Phase 1 is **Linux only** (tested on Arch/CachyOS with KDE Plasma
and WebKitGTK 2.54; other distributions and GNOME are untested). There is no Windows or Android version yet.

**Install.** Download or build `Atlas_0.1.0_amd64.AppImage` or `Atlas_0.1.0_amd64.deb` (see `apps/desktop/scripts/build-linux.sh`; nothing is published).
- AppImage: `chmod +x Atlas_0.1.0_amd64.AppImage && ./Atlas_0.1.0_amd64.AppImage` (about 110 MiB: it carries its own web engine). It needs `libayatana-appindicator` for the tray icon (Arch: `libayatana-appindicator`).
- `.deb` (Debian/Ubuntu): `sudo apt install ./Atlas_0.1.0_amd64.deb` (about 4 MiB; uses the system's WebKitGTK 4.1, GTK 3 and ayatana appindicator).
- You also need a **keystore** running: KDE Wallet (via its Secret Service) or GNOME Keyring. Atlas keeps its device key only there; if none is available it tells you and does not sign in. Unlock it if it asks.

**First run.** The sign-in page asks for: your **server address** (must be `https://...`, or `http://localhost:port` for a test server), your **e-mail and password** (sent once to your server to
create a device key; the password is never stored), a **device name**, your **notes folder** (Choose folder...: pick an empty folder or the folder where you already keep Markdown notes), and
**whether to start Atlas when you log in** (off unless you tick it). Then **Sign in**. The first sync downloads your notes into the folder and your tasks into the local database.

**The notes folder.** Every note is a `.md` file, in sub-folders like in Atlas. Edit them with any editor: Atlas notices (usually within a second or two; it also re-checks the whole folder
when Atlas starts, when you click back into its window and every five minutes), sends the change, and writes changes from other devices back into the file **only if you have not changed that file in the
meantime**. If the same note was changed on two devices, Atlas merges what it can; where it cannot, it keeps **both** versions: the other version appears as a new file named like
`name (conflict 2026-11-09 234332).md` next to your note. Rename a file or move it to another folder and Atlas treats it as a move; delete a file and the note is deleted on the server (it stays
recoverable there), and a note deleted elsewhere is moved to `.atlas-trash/` inside your folder, never erased. Files Atlas leaves alone and lists in **Settings > Desktop app**: larger than 5 MiB, not valid UTF-8,
or with a name that cannot exist on every platform (for example `CON.md`, names ending in a dot). Hidden files and folders (those starting with a dot, like `.git` or `.obsidian`) and non-Markdown files are never touched.
If the folder disappears (a drive that is not mounted) Atlas does nothing and says so; it never reads that as "everything was deleted".

**Tray and closing the window.** Closing the window **hides it**; Atlas keeps running so reminders and sync continue. Click the tray icon to open it again, or right-click for
**Open Atlas / Sync now / Quit Atlas**. **Quit really quits, and reminders stop with it.** On GNOME you may need an extension to see the tray icon; without it Atlas runs but you cannot see where.
You can turn "keep running in the tray" off in **Settings > Desktop app**; then the close button quits.

**Reminders.** A reminder created or changed on any device reaches this one, and Atlas shows a desktop notification at the time (within about a minute) **while Atlas is running** (window open or hidden in the tray). If Atlas was
not running at that time it shows what it missed (up to a day back) when you start it. In Settings you can switch reminders off for this computer or **hide the task text** in notifications (they then only say a reminder is due).
Your desktop environment's Do Not Disturb applies.

**Start at login.** Off by default. **Settings > Desktop app > Start Atlas when I log in** creates one start-up entry that opens Atlas hidden in the tray. For an AppImage the entry points at the AppImage's current location:
if you move the file, switch the option off and on again. Switching it off removes the entry.

**Signed out by the server.** If you remove this device in Settings > Devices in the browser (or its key expires), Atlas shows the sign-in page with a message; nothing on your computer is deleted, and signing in again to
the same account continues where it stopped (queued edits are kept). Signing in as a different account starts from an empty local database (your notes folder files are not deleted).
**"Update required"** means your server is newer than this app: install a newer Atlas app; your data is kept.

**What is different from the browser.** Account, password, calendar connections, device list, Web Push and the data export are only in the browser (a device key is deliberately not allowed to do those).
There is no service worker and no installable-app prompt in the desktop app.

**Uninstall.** Switch "Start Atlas when I log in" off first (or delete `~/.config/autostart/Atlas.desktop`). AppImage: delete the file. `.deb`: `sudo apt remove atlas`. Then, if you want everything gone: delete the data
folder `~/.local/share/app.atlas.desktop/` (the local database and settings) and remove the stored device key (KDE Wallet / GNOME Keyring entry "atlas-desktop", or just remove the device in Settings > Devices in the browser, which makes the key useless).
**Your notes folder is never deleted by Atlas or by uninstalling.**

**Known limits (phase 1).** Linux only; reminders fire only while Atlas runs (use the optional autostart); the restore confirmation, the notices and the text resolvers are in the desktop app since SYNC-11, but the desktop app's task and note screens still need a connection to save (no offline editing of tasks in the app); typing in the editor with a CJK
input method was not tested; on NVIDIA graphics Atlas turns off a WebKit renderer feature at start-up (`WEBKIT_DISABLE_DMABUF_RENDERER=1`) to avoid a crash; set `ATLAS_KEEP_DMABUF=1` to keep it on.

## Atlas for Android (new, SYNC-10)

**What it is.** The same Atlas screens as the desktop app, on your phone, kept in sync with your own server. Reminders are set with Android's alarm clock, so they appear **on time even when Atlas is closed** and after the phone restarts. It is installed from an APK you build yourself (nothing is in a store).

**Install.** Build with `apps/desktop/scripts/build-android.sh release aarch64` (once: `scripts/android-keystore.sh`, and **back up `apps/desktop/keys/`**; Android only accepts an update signed with the same key). Copy the APK to the phone or `adb install -r` it; allow "install unknown apps" for the app you open it from. Your server must be reachable with **HTTPS and a publicly trusted certificate** (a Tailscale certificate works; a self-signed one does not).

**First run.** Enter the server address, e-mail, password and a device name. Atlas asks to **show notifications** (Android 13+): say yes, and if you use Do Not Disturb, allow Atlas through it in the system settings. Your password is sent once to get a device key; the key is stored encrypted under a key that never leaves the phone's Keystore.

**Notes on the phone.** Your notes are ordinary Markdown files inside Atlas on the phone (other apps cannot open that folder) and are kept in sync with the server, which holds the master copy. To get them out as files, use **Settings > This app > Export notes**: Atlas zips them and opens Android's share sheet (save to Files, send to another app or computer). You can also **Keep notes in a shared folder**: Atlas asks you to allow "All files access", then copies the notes to `Documents/Atlas Notes`, where any editor can open and change them (Atlas picks the changes up when you return to it and every few minutes). Your old folder inside Atlas is renamed, not deleted; "Move notes back inside Atlas" reverses it. If you later take the permission away, Android closes Atlas and the notes folder shows an error until you move the notes back.

**Reminders.** Settings > This app > Reminder reliability tells you whether Android lets Atlas show notifications, whether exact alarms are on, and whether battery saving may stop Atlas (OnePlus, Xiaomi, Oppo, Huawei and Samsung phones often do; set Atlas to **Unrestricted** there). Tapping a reminder opens that task. **Background:** a reminder you create or change on another device reaches the phone while Atlas is running; to keep Atlas running in the background switch on **Keep Atlas connected in the background** (a small permanent notification; it costs some battery; after a restart, open Atlas once). There is no push wake-up yet. An alarm already set always fires. If you force-stop Atlas from the system's app settings, Android cancels its alarms until you open it again. While a reminder is pending, Android shows its "next alarm" icon.

**Signing out.** Settings > This app > Sign out of this device removes the key from the phone. Removing the device in Settings > Devices on another device signs the phone out at its next request.

