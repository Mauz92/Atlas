# Changelog

All notable, user-visible changes to Atlas are recorded here.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

- Added (TTRPG-02..07, ADR-0081..0083; not committed, CI not run): **the optional TTRPG module** (Settings > Plugins, off by default). Run a published tabletop adventure with your book and dice: campaigns with real Markdown session notes and a written handoff to the next session, a party with persistent hit points, conditions and resources and confirmed short/long rests, creature cards (by hand, or imported from the D&D 5e SRD with its licence notice), prepared encounters with independent slots and a launch link in your session note, and a combat tracker with physical initiative, turn order, conditions with expiry reminders, undo (conflict-checked), pause/resume across sessions and a readable history. Backups restore it, the full export adds a versioned `ttrpg.json`, and it works at phone width with the notes and the tracker as switchable panes. Works in the browser and, once switched on there, in the desktop and Android apps; a fight screen follows changes from another tab or device within seconds; finished fights keep their readable history and drop undo data. Limits: one DM, D&D 5e (2014) only, needs a connection. New operator settings: `TTRPG_SRD_ENABLED`, `TTRPG_SRD_BASE_URL`, `TTRPG_SRD_TIMEOUT_SECONDS`.
- Added (TTRPG-01, ADR-0081; not committed, CI not run): **Settings > Plugins** with an off-by-default **TTRPG** switch. Turning it on shows a TTRPG entry in the sidebar (an empty page for now; campaigns, party, encounters and combat follow in TTRPG-02..07). Turning it off hides it again and the server refuses its endpoints; nothing you created is deleted.
- Added (REL-02): `apps/desktop/scripts/release-android.sh X.Y.Z [--upload]` builds the Android APK signed with the owner's key, verifies the signature and, with `--upload`, attaches it and its checksum to the GitHub Release `vX.Y.Z`. The key stays in the owner's account; the tag pipeline does not build Android.
- Added (M5-12, ADR-0076): **manual calendar import.** Settings > Calendar > "Import a calendar file" adds a read-only calendar from an `.ics` file (checked first, 5 MiB limit, replaceable, removable). Fixed with it: when one of several calendar links failed, the others did not sync in that pass. Changed (ADR-0076): Google and Microsoft **API** calendar sync and calendar writing are deferred after 0.1.0; calendars come in through ICS links and files.
- Added (SYNC-10, ADR-0075; not committed, CI not run, one phone tested): **Atlas for Android.** The desktop app's shell now builds for Android (sideloaded APK) with a small Kotlin plugin: the device key lives in the Android Keystore, notes are kept in a folder inside the app, reminders are OS alarms that fire on time with Atlas closed and in Doze, a tapped reminder opens its task, and Settings > This app shows notification, exact-alarm and battery-saving status with shortcuts. Also on Android: **Export notes** (zip and share sheet), an optional **shared notes folder** other apps can edit in place, and an optional **Keep Atlas connected in the background** mode. **Not included:** push wake-up (UnifiedPush/ntfy). Tested on one phone and an emulator (R-82, R-83). Changed on every platform: the sign-in page shows its form only once it can handle a submit, and a device signed in from Android is recorded as platform `android`.

- Added (REL-01; not committed; **the release workflow and the updater on the real server have not run yet**): **releases and one-click server updates.** Pushing a tag `vX.Y.Z` builds the server images, the Linux desktop clients (AppImage, .deb; Windows optional and unverified) and a GitHub Release. **Settings > About > Server updates** shows the running and the newest version and updates the server on one confirmed click: the new version is downloaded while Atlas runs, a verified backup is taken, Atlas restarts on the new version, and if it does not start the previous version (and, if it was migrated, the database) is restored automatically. Nothing is removed. One-time setup on the server: `DEPLOYMENT.md` section 13. New setting `UPDATE_DIR` (set by the release compose file), new files `deploy/docker-compose.release.yml` and `deploy/updater/`. ADR-0074.

- Added (UX-12; not committed, CI not run): **accent colours.** Settings > Appearance has a new **Accent colour** picker: Neutral (the default, unchanged), Blue, Indigo, Violet, Pink, Red, Orange, Amber, Green and Teal. The choice applies at once, works with Light, Dark and System, is applied before the page paints (no flash, also on the sign-in screen) and is remembered in this browser only (it is not synced between devices). It colours primary buttons, links, focus outlines, checked boxes, progress, the selected item in the sidebar, bottom bar, tabs and segmented controls, and the note editor's selection, links and tags. A switch **Colour headings with the accent** (on by default; no effect for Neutral) also colours page titles, section headings, the sidebar's group names, the calendar's period title and note headings (editor and preview); body text, task titles, labels and the Overdue/Due today headers stay as they are. Overdue, due-today, priority, project and calendar colours do not change. Every accent meets the contrast ratios in both themes (tested). Selected menu items now use the accent tint instead of grey (identical for Neutral). No server change, no new dependency. Guide: `docs/USER_GUIDE.md` "Accent colour".

- Added (Calendar Stage A; not committed, CI not run; **read-only; live Google/Microsoft/Proton behaviour not yet verified**): **link and view your calendars.** Settings > Calendar has cards for **Google**, **Microsoft Outlook** and **calendar feeds (ICS, for example a ProtonMail "Share via link")**: a provider that the server does not have credentials for shows setup help instead of a Connect button; Connect starts a normal sign-in at the provider and returns to Settings; choose which calendars to show, give each a colour, see the last sync or the last error, **Sync now**, and **Disconnect** (which says that Atlas deletes the saved sign-in and the events it stored; your calendar at the provider is never changed). A feed link is a secret: it is stored encrypted and shown masked. A new **Calendar** page shows **Day, Week, Month and Agenda** (Agenda first on phones) in your time zone, with all-day and multi-day events, overlapping events side by side, recurring series and a read-only detail panel with an "Open in ..." link; **Today** and **Week** list the day's events in their own section (a task's due date never becomes an event). If a provider revokes access the card says "Needs re-authorisation" and the status bar says so. Operator: new settings `GOOGLE_*`, `MICROSOFT_*`, `ICS_*` (the redirect URI always derives from `PUBLIC_BASE_URL`), new command `atlas-admin calendar-status`, migration `a6c3e9d27b14`, new dependency `icalendar` (BSD-2-Clause). Setup guide and live-check runbook: `CALENDAR_SYNC.md` section 12. ADR-0071, ADR-0072.

- Added (SYNC-11; not committed, CI not run): **screens for what happens when two devices change the same thing.** (1) A banner **"Changed on another device"** and a page
  **Changes from other devices** (`/changes`, also linked from Settings > Sync): what changed, on which device and when, the replaced value of simple fields (never your text), with **Undo**.
  Undo only applies if nothing changed the value since; otherwise it says so plainly ("Not undone: ... was changed again since"), and kinds that cannot be undone in one step (a merged note edit,
  an edit that brought back a deleted item, a renamed note) say why and link to the item. (2) **Two versions of a text:** when a task's title or description changed elsewhere while you edited it, the
  task panel shows both versions with **Keep mine / Keep theirs / Edit merged**; nothing is saved until you choose. For notes the **Notes** page lists conflict copies ("N notes have two versions")
  with **Resolve**: a line comparison and Keep mine / Keep theirs / Merge in the editor; the copy goes to the trash only after the note was saved. (3) **Instant updates** status and a local **test notification**
  in Settings > Notifications, and live-connection / last-hint / push-gateway status in Settings > Desktop app. (4) Desktop app: Settings > Sync and the status bar show the sync engine's own state (the browser's
  offline queue is no longer started there), kept problems can be resolved or dismissed, and full-screen explanations appear when the server was restored from a backup (**Re-upload my local data** or
  **Discard local changes and re-download**, never automatic, the second asks twice and never deletes files in your notes folder), when the app must be updated and when the device was signed out.
  The browser app's behaviour is otherwise unchanged. New in the sync core: `discardLocalAndRedownload()`. No server or API change, no new dependency (eight Lucide icon shapes were added to the vendored set).
  Not built: offline editing in the desktop app's task screens, an offline mode in the browser (planned, ADR-0070). Guide: `docs/USER_GUIDE.md` section 7.

- Added (SYNC-09 phase 1, Linux only; not committed, CI not run): **an Atlas desktop app for Linux.** It keeps your notes as ordinary Markdown files in a folder you choose, syncs them,
  your tasks and your reminders with your own server, and shows the Atlas screens you know. Sign in once with your server address (`https://`), e-mail and password; the app gets its own
  device key and keeps it only in your system keystore (KDE Wallet / GNOME Keyring), never in a file, and never where the page can read it. Edit the files with any editor: changes are picked up
  and merged; when two devices changed the same text Atlas keeps both (the other version appears as a `name (conflict ...).md` file) and nothing is overwritten that you edited meanwhile.
  Deleted notes go to `.atlas-trash/` in your folder, never erased. Reminders from any device show as desktop notifications while the app runs; closing the window keeps it running in the tray
  (turn this off in Settings > Desktop app); starting at login is off unless you opt in at first run. If you remove the device in Settings > Devices (browser) the app shows its sign-in page, keeps your data
  and forgets its key. A new **Settings > Desktop app** section (only inside the app) holds the per-computer options; account, calendar, device and export settings stay in the browser. Build: `apps/desktop/scripts/build-linux.sh`
  (AppImage and `.deb`, nothing published); guide: `docs/USER_GUIDE.md` "Atlas desktop app for Linux"; operators: `docs/OPERATOR_GUIDE.md` 12a (HTTPS, no CORS change needed). Windows and Android are not built;
  automatic updates exist only in a special build and are off. No change to the server, the API or existing data.

- Added (M8-04b-ii, API and sync core; no app uses it yet): **a snooze or dismissal made offline now counts from the moment you tapped.** The reminder action endpoint accepts an optional `acted_at` (ISO time with an offset); the server clamps it to between 24 hours ago and 5 minutes ahead and uses it only as the starting point of the snooze, so a one-hour snooze made at 10:00 and synced at 14:00 no longer makes your other devices ring at 15:00 (they show it at once). Without it nothing changes. The device sync core can now follow reminders, backfill them for an already-installed client without a full resync, withdraw alarms of tasks you edited offline until the server recomputes them, and queue snooze/dismiss durably. `openapi.json` and the web API types are regenerated.

- Added (M8-04a/e, server only; no app uses it yet): **reminders are now part of what a device can sync.** The server computes the exact UTC moment of each task reminder and exposes it (never the task text) to signed-in devices, with the owner's snooze and dismissal; completing, archiving or deleting a task cancels it. New **Home time zone** setting (Settings -> Notifications): reminders for tasks without their own time zone now use it instead of UTC; the browser's zone is adopted automatically the first time you sign in. Devices can snooze (10 min, 1 h, 3 h, tomorrow morning) or dismiss a reminder. Optional and **off by default**: a long-poll endpoint for running apps and a content-free "sync now" message to your own ntfy server (see the operator guide; hardening required). Migrations `d3a5c8e1b7f2` and `e5b8f2a4c1d9` (reversible); not applied to your live database. Native desktop/Android reminder clients are not built yet.

- Fixed (UX-05): **Creating a note or folder works again when the notes list is empty.** The **New note**, **New folder** and
  **New from template** buttons in the tree header, and the empty state's **Create the first note**, set the "name this new note" state,
  but the box that asks for the name is drawn inside the note tree - which was replaced by the empty state when there were no notes yet,
  so the click looked like it did nothing. The tree now stays on screen while something is being created (and when a folder exists but
  there are no notes yet). No data, sync or settings change.

- Added (AUTH-01): **You can now recover a forgotten password in the browser.** At first-run setup Atlas shows a **recovery code** once
  (copy it or download it, then tick "I have saved my recovery code"; the app waits for that). On the sign-in page, **Forgot password?**
  takes your email, the recovery code and a new password; it signs you out of **every browser and every desktop or phone app**, and shows a
  **new recovery code once** (the old one stops working, so a code works one time). Accounts created before this release have no code:
  open **Settings → Account → Recovery code** and **Create recovery code** (your password is asked). **Regenerate** there makes a new one
  and ends the old. The server keeps only a salted hash of the code; wrong tries are limited and never reveal whether the email exists. New
  setting `RECOVERY_ENABLED` (default `true`; `false` turns the feature off for operators who prefer the command line), new operator command
  `atlas-admin recovery-code --email <email>`, new migration `c9e4a7b2d6f1` (`recovery_codes`; reversible; applied by the next
  `atlas-migrate`). A restore from an older backup brings back the older code (`docs/OPERATIONS.md` 2.2b). `atlas-admin reset-password`
  is unchanged and remains the fallback when both password and code are lost (ADR-0067, `docs/SECURITY.md` section 13).

- Added (SYNC-06): **Devices can now sign in to your server on their own, for the coming desktop and Android apps.** An app signs
  in once with your email and password and receives its own key (shown once to the app, never stored by the server, which keeps
  only a fingerprint). With it the app can sync tasks, projects and notes, but it cannot change your password, export your data,
  connect calendars or sign out your other devices. New in **Settings → Devices**: the list of signed-in devices with their
  platform and when they last connected, **Rename**, **Sign out** (effective on the device's very next request) and **Sign out all
  devices**. Changing your password signs out your other browsers as before; the new box **Also sign out my devices** also ends the
  apps' keys (off by default so a routine change does not break your apps; tick it if you think the old password was exposed).
  `atlas-admin reset-password` signs out every device too, and `atlas-admin list-devices` / `revoke-device` exist for the server
  operator. The record of automatic decisions (SYNC-05) now says which device made each change. Keys unused for 90 days
  (`CHANGE_RETENTION_DAYS`) expire; devices signed out more than 90 days ago are forgotten. A restore from a backup brings devices
  back as the backup had them: sign out again any device you revoked since (`docs/OPERATIONS.md` 2.2a). Browsers are unchanged
  (ADR-0065, `docs/SYNC_PROTOCOL.md` 10.1).

- Changed (UX-11): **The remaining pages fit a phone, and the standalone Board page is gone.** On a phone, Tasks has one round box per
  row (the select boxes appear only after **…** → **Select tasks**) and the filter chips are one **Filters** button that opens a sheet;
  a project's **Board** tab shows one column at a time with a tab strip and counts (the help is behind a **?**); Notes shows the note's
  name and folder with one **Source | Live | Preview** switch and the rest in **…**; Projects are cards with a colour dot and a one-line
  summary; the command palette is a full-screen sheet with big rows and a Close button; Medium and Low priority show their word; the
  "Synced" link is a big target; Inbox shows only the capture button. **Removed:** the **Board** page and the **List | Board** switch on
  Tasks. Kanban stays in each project's **Board** tab; `/board` now opens **Projects**. A task that has no project is on no board.
  No data, sync or settings change (ADR-0064).

- Changed (UX-10): **Week fits any screen, and the phone gets a capture button and bottom sheets.** Week is now a set of day cards
  that fill the width (one column on a phone, more on a wider screen), so Saturday and Sunday are never cut off and no text is clipped;
  today's card is highlighted, an empty day is one quiet line, and week navigation is one segmented control with large touch targets.
  On a phone a floating **+** button on Today, Inbox, Upcoming, Week, Tasks and project pages opens a capture sheet that stays clear of
  the on-screen keyboard; the **…** menu of a task (and the due-date popup) opens as a bottom sheet with large items. Text fields are
  16 px on phones (no zoom on focus), the bottom bar respects the home-indicator area, and filter chips, the rail and the week
  segments are at least 44 px on touch screens. No data, sync or settings change (ADR-0063).
- Changed (UX-09): **Task lists are easier to read, especially on a phone.** Each task is now up to three lines: the title (larger on a
  phone), then when it is due (with an icon and the word **Overdue** or **Today**, never only a colour), its priority and subtask
  count, then its project (with a small colour dot that is the same everywhere for that project) and at most two tags. Tapping
  anywhere on a task opens it; the checkbox and the **...** button are 44 px targets on touch screens. Today, Inbox, Upcoming, Week
  and Tasks group tasks into cards on a softly tinted page (phone) with sticky section headers that show counts; Overdue and Due
  today are marked with an icon and a colour. Upcoming says "Tomorrow" and no longer repeats the date in every row; on Today a row
  due today shows only its time. Today's note preview shows plain text without the Markdown markers. Only Urgent and High
  priorities are coloured. No data, sync or settings change (ADR-0062).
- Added (SYNC-05): **The server now remembers what it decided on its own, and can undo it, for the coming desktop and Android
  apps.** When two devices change the same status, priority, date or project of a task or project, or move the same note, the later
  change wins as before - and the server now keeps a record of the value that lost (not any text, never note content) for 90 days.
  Other devices learn of it through the normal sync (`resolution` entries in `GET /api/changes`), and an app can list the record
  (`GET /api/sync/resolutions`) and undo one entry (`POST /api/sync/resolutions/{id}/undo`). An undo only restores the old value if
  nothing changed it since; otherwise it says so and changes nothing. Merged notes, revived deletions and renumbered note names are
  recorded too and point to the note history, to "delete again" or to "rename". The record is part of every database backup. Nothing
  changes for the web app. Details: `docs/SYNC_PROTOCOL.md` section 9.
- Fixed (SYNC-05): a note delete that the server had refused (the note was edited after the delete was based) and that was then
  retried with the same request key got an empty, invalid answer; the refusal is now repeated.

- Changed (P0-1): **Docker Compose install fixes.** The web container now listens on `127.0.0.1:8080` only (set `WEB_BIND=0.0.0.0`
  for the old behaviour); `POSTGRES_PASSWORD` now sets the database password for both the database and the app (a
  `DATABASE_URL` in `.env` is ignored by Compose); `ALLOWED_HOSTS` no longer makes the api container unhealthy; every setting
  is forwarded to api and worker; `atlas-export` sets are kept in a volume; an oversized note gets a short error. HTTPS and
  backup steps are in `docs/DEPLOYMENT.md` sections 8 and 11.

- Added (SYNC-04): **Notes now merge instead of conflicting, for the coming desktop and Android apps.** Apps that send
  `Atlas-Sync: 1` can save a note they edited offline from an older version: edits in different parts merge silently
  (line endings, the final newline and the front matter are kept exactly); edits that touch never overwrite anything, the
  losing text is saved whole as a `name (conflict ...).md` beside the note. An edit of a note deleted elsewhere brings it back,
  a stale delete is refused, and names that cannot exist on Windows or Android (`CON.md`, `a:b.md`, trailing dots, names that differ
  only by letter case) are refused or renumbered. The web app is unchanged.
- Added (SYNC-04): **Note history.** The server keeps the text of the last 20 revisions of every note, plus everything from the
  last 90 days (bounded in size), under `<notes root>/.atlas/history`; it is in every backup. `GET /api/notes/{id}/history` lists
  it and `.../history/{revision}` reads one revision, including those of a deleted note. Settings: `NOTE_HISTORY_KEEP_REVISIONS`,
  `NOTE_HISTORY_KEEP_DAYS`, `NOTE_HISTORY_MAX_REVISIONS`, `NOTE_HISTORY_MAX_BYTES`. Note that overwritten and deleted text is
  therefore kept up to 90 days.
- Fixed (SYNC-04): a request carrying a lone surrogate in a JSON string (for example a note) was answered `500`; it is now `422`.
  Note text containing a NUL character is now `422` (it could never be indexed).

- Added (SYNC-03): **The server now speaks sync protocol v1 for the coming desktop and Android apps.** Nothing changes for the
  web app. Apps that send `Atlas-Sync: 1` get: ids they choose themselves (a retry never duplicates), field-by-field merging of
  edits made on two devices (a title on one and a due date on the other both survive; the same text changed on both is reported as
  a conflict that keeps both versions; for other fields the later one wins and is reported), an edit made on one device beating a
  delete on another, and a feed that lets a brand-new device download everything. Unsupported apps are told to update (`426`).
  Details and what is still to come (note merge, undo log, device tokens): `docs/SYNC_PROTOCOL.md`.
- Changed (SYNC-03): **Deletion history is kept 90 days instead of 30** (`CHANGE_RETENTION_DAYS`, minimum 30; update `.env` if you
  set it), and only deletions are forgotten after that: a device can always download everything from scratch, and a device away
  longer than 90 days is told to resynchronise instead of silently missing deletions. Saved-request keys expire with it.
- Added (SYNC-03): **`atlas-admin record-restore`**: run it after restoring a backup so that apps which synced with the old
  server stop and ask before syncing again (`docs/OPERATIONS.md` section 2.2a).
- Changed (SYNC-03): an API user can now give a new task, project or note its own id (`id` in the create request); a note may be
  created at the path of a deleted note under a new identity when it has an `id`. Existing behaviour without `id` is unchanged.

- Fixed (SYNC-03): **Two devices saving the same item at the same moment can no longer both "win".** When two edits to
  one task, project or note were based on the same version and arrived together, both were accepted and the second
  silently replaced the first while both reported the same new version. Now one is saved and the other gets the usual
  "changed since it was read" conflict (`409`) with the current version, so no edit is lost without a warning.
- Fixed (SYNC-03): **Notes up to 5 MiB can be saved through the bundled web container** (its nginx limited requests
  to 1 MiB, so larger notes failed with `413`). Rebuild the `web` image to get the fix. The request limit is now 11 MiB, which
  also covers a 5 MiB note made entirely of line breaks or quotation marks (each is sent as two bytes).
- Fixed (SYNC-03): **A task can no longer end up inside a project that was deleted at the same moment.** Moving, creating
  or restoring a task into a project while that project was being deleted could leave the task attached to the deleted
  project (invisible in the project list, still counted by the task). The two requests are now ordered: the task is rejected
  ("project does not exist") or is filed out of the project by the delete.
- Fixed (SYNC-03): **A note deleted outside Atlas (removed from the notes folder) is now treated like a note deleted in
  Atlas**: its project links are removed and other devices are told, instead of leaving the project listing a note that
  no longer exists. Task links are kept, as for a deleted note, and return if the file reappears.
- Fixed (SYNC-01): **Notes edited, added or deleted outside Atlas now reach other devices.** When Atlas notices a change
  made directly in the notes folder (the periodic scan or `Reconcile`), it now announces it on the change feed
  (`GET /api/changes`) like any other edit; before, other devices never learned of it until they reloaded the note. The
  feed also tells a device whose position is *ahead* of the server (for example after the server was restored from an
  older backup) to resynchronise (`resync_required` with the new `resync_reason`: `cursor_ahead` or `below_floor`)
  instead of reporting "nothing new". Known and not yet fixed: notes larger than about 1 MiB cannot be saved through
  the bundled web container (its nginx limit is 1 MiB, notes may be 5 MiB); see `docs/DEPLOYMENT.md` section 8.
- Changed (UX-08): **Settings is one page with sections.** A list on the left (**Account**, **Appearance**,
  **Notifications and reminders**, **Calendar**, **Sync**, **Data and backups**, **About**) and one section at a
  time on the right; the section is in the address (`/settings/sync`), so a link or a reload keeps it. Sync,
  Calendar and Notifications are no longer separate pages: their old addresses open the matching section, and the
  command palette still offers "Go to Sync", "Go to Calendar" and "Go to Notifications". Each setting is a row
  with its name and a line of explanation on the left and the control on the right. On a phone the list comes
  first and each section opens with an **All settings** link back. Lists show grey placeholder rows (not
  "Loading…" text) while they load, with no movement of the page when the data arrives; they stop shimmering
  when your system asks for reduced motion. Every empty list now looks the same (icon, one sentence, at most one
  button): *Inbox zero*, *Nothing is due today* (one message instead of three empty groups), *Nothing is
  scheduled…*, *Nothing planned for this week*, *No projects yet*, and on Tasks *No open tasks* (with **Go to
  Inbox**) versus *No tasks match these filters*. The sign-in and first-run pages are now a proper `main`
  landmark and announce errors. Nothing stored or sent changed.
- Changed (UX-07): **Tasks, Projects and Board are tidier.** The Tasks page has one filter bar: a search box and
  chips for **Status**, **Priority**, **Project**, **Due** and **Sort** (each opens a small menu; Due also lets
  you type a date range) plus a **List | Board** switch. Chips that differ from the default show their value;
  **Reset filters** appears when anything is set. **Save this view…** and your saved views are in the **…**
  menu at the end of the bar. Selecting tasks shows a bar that floats at the bottom of the window (complete,
  move to a project, delete with undo, clear). The address of the page is still the view (it now also holds
  `view=board`). **Board** view shows the same filtered tasks in columns; on any board, cards are compact (title,
  project, due date, priority flag), the **Archived** column is behind **Show archived**, and with a card focused
  **]** / **[** move it to the next / previous column Atlas allows (the card keeps focus; a screen reader is told).
  **Projects** lists each project as a row with a progress bar, how many tasks are open, its target date and a
  **…** menu (open, archive or restore); archived projects are behind **Show archived**. A project page has a
  header (name, status, progress, dates, **…** for edit and archive) and tabs **Tasks | Board | Notes**;
  completed and archived tasks are folded into **Completed (n)** and **Archived (n)**. Dates now read the same
  everywhere (for example "Wed, Nov 4", with the year only when it is not this year); project dates no longer
  show as `2026-10-13`.

- **Account recovery.** New operator command `atlas-admin reset-password --email <email>` (and `list-users`) resets a forgotten password on the server and signs the account out everywhere. Not reachable over the network.

- Added (UX-06): **Live editing mode for notes.** The note header has a new **Source | Live** switch next to
  **Preview**. In **Live**, Markdown is shown the way it reads while you keep typing in the same text: headings
  are large, `**bold**`, `*italic*`, `~~strikethrough~~` and `` `code` `` lose their marks, links show only their
  words, `- [ ]` / `- [x]` lines become checkboxes you can click, `[[wiki links]]` become links (click to open
  the note), `#tags` are highlighted, and code blocks, quotes, lists and rules are styled. The line your cursor
  is on (or the lines you select) always shows its Markdown, so you can edit anything. **Source** is still
  there and shows the plain Markdown. Live is the default; Atlas remembers your choice in this browser. The
  file on disk is exactly what you typed in either mode: Live only changes how the text is displayed (ticking a
  checkbox changes the one character in the brackets, and Ctrl/⌘ Z undoes it). Links to the web open only with
  Ctrl/⌘ click and only for `http`, `https` and `mailto` addresses; **Ctrl/⌘ Enter** opens the link or ticks
  the task at the cursor. Also fixed: a note with Windows (CRLF) line endings no longer has them changed to
  `\n` by the editor on the first keystroke (the server still reads such files with `\n`, see `RISKS.md` R-24).

- Changed (UX-05): **notes save by themselves and the Notes page is a workspace.** There is no **Save** button
  and no "Discard unsaved changes?" question any more: a note saves about a second after you stop typing, and
  when you switch notes, create, rename, delete, open today's note, leave the page or sign out (Ctrl/⌘ S saves
  at once). The note header shows **Saving…**, **Saved**, **Offline — saved on this device**, **Conflict** and
  so on. What you type is also kept on this device until the server has it, so a crash, a closed tab or being
  offline does not lose it; open the note again and it is put back and saved. If the file was changed
  somewhere else (another program, another device), nothing is overwritten: your text stays and you choose
  **Keep my version as a copy** or **Reload server version**. The page is now a file tree (icons for New note,
  New folder, New from template and Today's note; a **…** menu on each row with Rename in place, Move to… and
  Delete; no path box and no prompt), a full-height editor with a readable column, and a details panel for
  Links, Backlinks, tasks, projects and tags (Ctrl/⌘ Alt B). **Task from selection**, **Rename** and **Delete**
  moved into the note header's **…** menu, **Preview** is a toggle, and `[[links]]` in the preview open the
  note. On screens under 1280 px the main sidebar tucks away on this page.

- Changed (UX-04): **the task panel saves by itself — there is no Save button.** The panel is now a calm
  list of properties: a large title you edit in place, then Status, Priority, Due (date and time), Start, Time
  zone, Project and Tags, then the description, Repeat, Subtasks, Reminder and Linked notes. Choices from a
  menu save at once; text saves after a short pause and whenever you leave the field, close the panel, open
  another task or leave the page. The top of the panel says **Saving…**, **Saved**, **Offline — not saved** or
  **Conflict**. If the task was changed somewhere else, nothing is overwritten: your values stay, and **Load
  latest version** shows the newer one with your changes set aside to **Reapply** or dismiss. If Atlas rejects a
  value (for example an empty title), its message appears under the field and your text stays. Closing with an
  unsaved change asks first. The time zone is chosen from a searchable list. Tags are chips: type and press
  Enter (or a comma) to add, × to remove. A reminder applies as soon as you choose it. On a wide screen
  (1280 px and up) the panel sits beside the list, which stays usable; on smaller screens it opens over the page
  (Esc or a click outside closes it) and on a phone it fills the screen. **…** in the panel has **Copy link**
  and **Delete task** (with Undo). Ctrl/⌘ Enter still works and simply saves at once. (Notes followed in UX-05.)

- Changed (UX-03): **calmer task rows with a menu and keyboard keys.** Every task list (Today, Inbox,
  Upcoming, Week, Tasks, a project's list and search results) uses one row: a round checkbox instead of the
  **Complete** button, the title, and a grey meta line (project, due date in amber when overdue, priority
  flag, subtask progress, `#tags`). Pointing at a row (or moving into it with the keyboard) shows **Schedule
  for today**, **Pick a date** and **Move to a project**; the **…** button opens a menu with Today, Tomorrow,
  Next week, Pick a date…, No date, Priority, Move to project, Status and Delete (with Undo). The Inbox no
  longer shows six controls per row, and on a phone nine Inbox items fit on one screen. New list keys (when not
  typing): **j**/**k** move, **Enter** opens, **x** completes or reopens (on the Tasks page: selects), **t**
  today, **m** project menu, **p** priority menu; they are in the **?** list. Board cards are compact, and the
  status drop-down on each card is now **…** → **Move to…**. On the Tasks page the selection box sits before the
  round checkbox and appears when you point at a row or once something is selected.
- Fixed (UX-03): a subtask in a list now names its parent (↳ *parent*) instead of looking like an unrelated
  task. The project page no longer offers **Complete** on tasks that are already completed: they show a ticked
  checkbox, and unticking it reopens the task.

- Changed (UX-02): **a new app shell.** On the left an icon rail goes to **Today**, **Inbox**, **Tasks**,
  **Projects** and **Notes**, with **Settings** at the bottom. Next to it the sidebar has **Search** (opens the
  Ctrl/⌘ K palette) and three foldable sections: **Planning** (Today, Inbox, Upcoming, Week), **Workspace**
  (Tasks, Board, Projects with your active projects, Notes) and **More** (Search page, Calendar, Sync,
  Notifications, Settings). **Ctrl/⌘ B** hides or shows the sidebar; Atlas remembers it, and which sections are
  folded, in this browser. Exactly one item is highlighted for the page you are on. The top bar is gone: your
  name, the theme button and **Sign out** are at the bottom of the sidebar (and *Toggle sidebar* / *Sign out* are
  in the palette). A status bar at the bottom shows **Synced**, **Offline · N queued** or **N conflicts** (opens
  Sync), the calendar's last sync (opens Calendar) and **Shortcuts**. On phones there is a bottom bar (Today,
  Inbox, Tasks, Projects, Notes), a menu button that opens the sidebar as a drawer and a search button; the
  sideways-scrolling nav row is gone. The **Day** view is no longer in the navigation: `/day` opens Today. Every
  other address works as before. A **Skip to content** link is the first stop for keyboard users. Icons are
  bundled with Atlas (Lucide, ISC licence); nothing is downloaded. No migration.

- Changed (UX-01): **a calmer, consistent look, and dark mode everywhere.** Atlas now uses one neutral design
  (grey surfaces, ink text, no blue): one type and spacing scale, quieter buttons (one dark primary button per
  form; other actions are plain text buttons), visible outlines on fields and checkboxes, and colour only where
  it means something. Priorities read in sentence case and are coloured only when they need attention
  (**Urgent** red, **High** amber); tags show as `#tag`. **Theme** in Settings is now **System** (the default,
  follows your device), Light or Dark, and the sign-in and first-run screens follow it too, without a white
  flash on load. In Notes the editor and preview are no longer cut off at part of the screen height, the
  editor's line-number gutter is dark in dark mode, text is limited to a comfortable line length, and the
  toolbar shows **Saved** / **Unsaved changes** instead of a revision number (hover the file name to see it).
  Checkboxes in the note preview and the editor now have accessible names. No migration.
- Added (MU-08): **Settings, keyboard help and a tidier shell.** Settings now has your **account** (change your
  display name; change your password — it asks for the current one, needs at least 12 characters and signs
  you out on your other devices), **theme** (Light/Dark), **reminder timing and notification status**,
  **Export your data** (downloads the zip), **Backups** (a read-only summary: last backup, sizes, schedule,
  last scheduled run; it says so if the backup folder is not visible to the app) and **Instance** (Atlas
  version, database status, schema revision). Press **?** (when not typing) or choose **Keyboard shortcuts**
  in Ctrl+K to see the shortcuts. On phones the navigation is a single scrolling row. Email addresses ending
  in `.local` are now accepted. Accessibility fixes found by an automated check: stronger button colour in
  the light theme and a duplicate page landmark in the task panel. Loading messages are announced to screen
  readers and the Notes page shows a loading state and a retry. New endpoints `PATCH /api/auth/me`,
  `POST /api/auth/password` and `GET /api/instance`; validation errors on `/api/auth/*` no longer echo the
  submitted value. No migration. See ADR-0050.
- Added (MU-07): **Today is your home page, with a note for each day and note templates.** Today now shows
  overdue work, what is due today, work scheduled to start today, a card for today's note and a place for
  calendar events (empty until a calendar is connected). **Open today's note** (on Today, on the Notes page
  or Ctrl+K) creates `daily/YYYY-MM-DD.md` the first time and opens the same file afterwards; the day is your
  browser's calendar day and an existing note is never overwritten. Notes can be started from any note in the
  `templates/` folder (**New note from template**, also in Ctrl+K); `{{date}}` and `{{title}}` are replaced,
  nothing else is. A note `templates/daily.md`, if you have one, is the template for daily notes. New
  endpoints `POST /api/notes/daily` and `POST /api/notes/from-template`; creating any note can no longer
  replace a file that appeared in the meantime. No migration. See ADR-0049.
- Added (MU-06): **notes, tasks and projects linked.** In a note, put the cursor on a line (or select
  text) and choose **Task from selection**: a title is proposed from the text (list marker and checkbox
  removed) and you confirm it; the new task links back to the note and, if the note belongs to exactly one
  project, is filed there. A checkbox in a note never becomes a task by itself, and the note text is not
  changed. The note's **Backlinks** now list the notes that link to it, its tasks and its projects; a task's
  detail lists its **Linked notes** (open or unlink) and the link follows a renamed note. Typing `[[` in the
  editor offers your notes and inserts `[[path]]`. New endpoints `POST /api/notes/{id}/tasks`,
  `GET /api/tasks/{id}/notes`, `DELETE /api/tasks/{id}/notes/{note_id}`; the note detail gains `tasks` and
  `projects`; one additive index (migration `b7d3e1a95c24`).

- Added (MU-05): **command palette and search.** Press **Ctrl+K** (**Cmd+K** on a Mac) anywhere, or use
  the *Search* button in the top bar, and type: notes, tasks and projects whose words start with what you
  typed appear in groups (a word inside a note's text counts too). Arrow keys move, **Enter** opens, **Esc**
  closes. A task opens its detail, a project its page and a note opens in Notes. The same box runs
  commands: *Go to* any view, *Toggle theme*, and *New task / note / project* named by the text you typed
  (nothing is created by Enter alone). The Search page now shows full results for the same query and keeps
  it in the address. Notes can be linked as `/notes?open=<note id>`. New endpoint `GET /api/search`; new
  database indexes for task and project search (migration `a8c4d9e2b7f1`).

- Added (MU-04): **repeat, subtasks and reminders in the task detail.** *Repeat* offers daily, weekly,
  monthly or a custom RRULE and previews the next occurrences as the server computes them; a bad rule shows
  the server's message. Completing a repeating task completes only that occurrence and shows (and opens)
  the next one, or says the series has ended. *Subtasks* can be added, completed, opened and removed, with
  progress. *Reminder* sets a timing for this task only (or returns to your default) and shows when the next
  reminder fires; delivery is unchanged. New read-only endpoint `POST /api/tasks/recurrence/preview`.

- Added (MU-03): **Tasks page.** Tasks lists every task and narrows it by text, status (open by default),
  priority, project and a due-date range, sorted by urgency, due date, newest or title. The filter is in
  the page address, so a view can be bookmarked and survives a reload; **Saved filters** keep named views
  in this browser. Tick tasks (Space on a focused checkbox, or Select all) to complete, move them to a
  project, or delete them, with an **Undo** for delete. Rows open the task detail. No server change.

- Added (MU-02): **Projects.** The Projects page lists your projects with their progress and lets you
  create, archive and restore them. A project page shows its description, dates, progress, tasks (as a
  list or a board), and linked notes, and lets you edit it, add tasks and link or unlink notes. Tasks can
  be filed under, moved between or removed from a project in the task detail. Active projects are listed
  in the sidebar.

- Added (MU-01): **task detail and editing.** Open any task from Today, Inbox, Upcoming, Day, Week or the
  Board (click the title, or focus it and press Enter) to edit its title, description, status, priority,
  due date and time, time zone, start and tags in a side sheet (a full page on narrow screens); Esc
  closes it (after asking when edits are unsaved). The server's validation message is shown as-is, and a
  task edited elsewhere shows a conflict instead of being overwritten. Tasks can be deleted from the
  detail or the Inbox with an **Undo**.
- Added (MU-01): capturing a task on **Today** makes it due today. **Inbox** rows can be scheduled
  (Today / Tomorrow / a date), filed to a project, or deleted; scheduling and filing move the task out of
  the Inbox. A due date without a time is stored as the end of that day and shown without a clock time.
- Added (MU-01, API): tasks carry **tags** (`tags` on create/update/read, replace semantics) and
  `POST /api/tasks/{id}/restore` undoes a delete. No schema change.
- Fixed: account setup accepts addresses on special-use domains such as `.test`, and form errors show
  the server's validation message instead of "Unprocessable Content".
- Fixed: the new-note controls no longer squash the note-name field in a narrow sidebar.

## [0.1.0-pre] — 2026-10-27 — development snapshot · **NOT production-ready**

**Release label: `0.1.0-pre` — a development snapshot, neither a finished nor a production release.**
The full checklist, the consolidated known-limitations list and the per-requirement readiness are in
[`docs/RELEASE.md`](RELEASE.md) and [`docs/ACCEPTANCE.md`](ACCEPTANCE.md) (§"Release Readiness (M9)").

- **In this snapshot and verified:** Markdown notes (M2); task management and the Inbox/Today/Upcoming,
  Day/Week and Board views (M3, M4); projects, Kanban, derived progress and note↔project links (M4);
  cross-device/offline sync (M7); reminders, Web Push and notification preferences (M8-01/02/03/05);
  the calendar **foundation** — encrypted credential store, adapter contract, event projection +
  cursors, sync-status surface and reconciliation (M5-01/02/06/08/10); and security/recovery —
  auth, encrypted tokens, tested backup + restore, vulnerability scan, security review and
  upgrade/rollback (M1, M9-01…07).
- **Not delivered — blocked on external resources:** connecting Google/Microsoft calendar accounts and
  the calendar **event views** (M5-00 `BLOCKED`, AR-001; M5-03/04/05/07/09 `BACKLOG`), **bidirectional
  calendar editing** (M6), **mobile apps** and **native/real push** plus the desktop matrix
  (M8-04/06/07/08). These are **not** claimed as working.

The user-visible changes accumulated in this snapshot are listed under *Unreleased* below.

## [Unreleased]

### Fixed
- **API failed to start** when `ALLOWED_HOSTS` (or `CORS_ORIGINS`) was set to a plain host name or left
  blank, as `.env.example` documents. Both settings now accept a comma-separated list or a JSON list.
- **Docker Compose now forwards** `ALLOWED_HOSTS`, `VAPID_*`, `EXPORT_DIR`, `CHANGE_*`,
  `NOTES_RECONCILE_SECONDS`, `BACKUP_INTERVAL_SECONDS` and `TOKEN_ENCRYPTION_KEY_ID` to the API and
  worker, and publishes the API port on `127.0.0.1` only (the web container still reaches it).

### Added
- **Atlas for Android (SYNC-10, ADR-0075):** the desktop app's shell built for Android with a small Kotlin plugin: device key in the Android Keystore, notes folder inside the app, OS-scheduled reminders (exact, with the app closed and in Doze), tap-to-open, a Settings section for notification/exact-alarm/battery status. Sideloaded APK; background sync and a shared notes folder are not included (R-82, R-83). Changed on all platforms: the sign-in page shows its form only after its handler exists; a device signed in from Android reports platform `android`.
- **Milestone 9 — the release is labelled, checklisted, and its known limitations are listed
  (documentation, no behaviour change).** A new [**Release document**](RELEASE.md) states the honest
  status: the label is **`0.1.0-pre` — a development snapshot, NOT production-ready**, because the
  calendar (**M5/M6**) and mobile/device (**M8**) gates remain **open** on external resources. It carries
  the pre-release checklist (build, tests, security/advisories, backup, restore, upgrade/rollback, docs —
  each item citing its evidence), a consolidated **known-limitations** list (the blocked calendar and
  mobile work; the API-first UI gaps; the operator **Compose env-forwarding caveat**; and the residual
  risks **R-SEC-1/2/4**, **R-17**, **R-20**, **R-21**), and the exact work that is **blocked on external
  resources** (real Google/Microsoft accounts, real devices and a push service). The per-requirement
  readiness (**REQ-001…015**) is filled honestly in [`ACCEPTANCE.md`](ACCEPTANCE.md) §"Release Readiness
  (M9)" — no blocked/incomplete requirement is marked as passing. `README.md`'s status now points at the
  release document. See `docs/ACCEPTANCE.md` (M9-08).
- **Milestone 9 — a User Guide and an Operator Guide (documentation).** Two new guides make Atlas
  usable and operable from the docs alone:
  [**User Guide**](USER_GUIDE.md) — how to use notes, tasks (Inbox/Today/Upcoming, Day/Week
  planning), the Kanban board, projects and derived progress, note search, offline sync and the
  **Sync** page, desktop notifications and reminder timing, the calendar status surface, and themes;
  and [**Operator Guide**](OPERATOR_GUIDE.md) — installing, configuring (including **VAPID keys** and
  the token-encryption key), securing, backing up, restoring, upgrading/rolling back, monitoring and
  troubleshooting. Both link the authoritative documents rather than duplicating them and clearly
  mark what is **not** delivered yet (calendar accounts, mobile apps, real push delivery; the
  placeholder Tasks/Projects/Search/Settings pages). The operator guide also documents generating a
  VAPID key pair and the fact that the shipped Compose file forwards only a subset of environment
  variables to the containers. `README.md` now links both guides and states the milestone status
  honestly. No application behaviour changed; see `docs/ACCEPTANCE.md` (M9-07). The release checklist
  and consolidated known-limitations list remain M9-08.
- **Milestone 9 — upgrading and rolling back is now documented and proven (operational).** The
  deployment guide (`docs/DEPLOYMENT.md` §6–§7) now carries an ordered, copy-pasteable runbook for
  upgrading an existing installation and rolling it back: **back up first** (a verified
  `atlas-backup` set), apply the versioned migrations (`alembic upgrade head` / `atlas-migrate`), and
  verify (migration state = head, schema matches the models, `/health/ready`). Both directions were
  actually executed: a database at an earlier revision with representative data was upgraded to head
  (data preserved, schema and models in agreement, app healthy), and a rollback was performed both by
  `alembic downgrade` and by restoring the pre-upgrade backup. The same check confirmed the SPA's
  security headers/CSP are served by the running web container. No user-visible change to the app
  itself; the runbook and evidence are in `docs/ACCEPTANCE.md` (M9-06).
- **Milestone 9 — security review of the whole delivered surface (mostly internal; one hardening
  change).** The threat model in `docs/SECURITY.md` was checked control-by-control against the shipped
  implementation: authentication/authorisation on every protected endpoint, session and CSRF handling,
  input validation at the boundaries, path-traversal protection for notes, parameterised database
  access, Markdown sanitisation, secret handling/redaction, encrypted OAuth credentials at rest, the
  user-scoped change feed and notification registry, and the backup/export path-safety. Every applicable
  control is implemented and backed by tests; the record (findings and residual risks) is in
  `docs/SECURITY.md`. One gap was found and fixed: the web app's document (served by nginx) now sends
  standard security headers — `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`,
  `Permissions-Policy` and a **Content-Security-Policy** — so the defence-in-depth headers apply to the
  app itself, not just to API responses. No finding was suppressed; one low residual risk (a push
  destination endpoint is not restricted to an `https` push-service host) is recorded in
  `docs/RISKS.md` (R-21) and accepted for the single-user deployment. See `docs/ACCEPTANCE.md` (M9-05).
- **Milestone 9 — take all of your data out of Atlas, in open formats.** A new **full data export**
  captures your entire workspace in one self-describing bundle: your **notes as their real Markdown
  files** (byte-identical, `notes/`), your **tasks and projects** as the versioned open
  `atlas.project-export` document (`data.json`, including the tasks filed under no project), a notes
  metadata index (`notes.json`, for links and tags) and a **manifest** listing every file with its
  size and **SHA-256** so the set verifies itself. Download it from the app (an authenticated
  `GET /api/export` returns a zip of your own data) or produce it on the server with the new
  **`atlas-export`** command (`run` | `verify` | `list`). It is strictly your own data, read as one
  consistent snapshot. This is a *portability* artifact, **not** a backup — for recovery keep using the
  backup/restore procedure. See ADR-0042 and `OPERATIONS.md` §1.3.
- **Milestone 9 — dependency/vulnerability scan (internal; no user-visible change).** The backend and
  frontend dependency trees were scanned against published advisories and are **clean**: `pip-audit`
  found **0** advisories across 91 installed packages and `npm audit` found **0** across 370 locked
  packages (all severities). No dependency was added, upgraded, downgraded or pinned, and no finding was
  suppressed to green a build. The CI gate already fails the build on an unresolved finding, so no
  workflow change was needed and nothing user-visible changed. See `docs/DEPENDENCIES.md` and
  `docs/ACCEPTANCE.md` (M9-04).
- **Milestone 9 — restoring from a backup is now proven, and documented (operational).** A
  copy-pasteable **restore runbook** (`OPERATIONS.md` §2) was executed end to end: a backup set was
  restored into a scratch PostgreSQL database and a scratch notes directory, and the restored notes
  (byte-identical) and data (identical rows, matching schema/migration state) were verified against the
  source. A tampered or partial set still fails the integrity check, so a damaged backup can never be
  restored by mistake. This closes the gap that an integrity-checked backup is not, by itself, proof it
  restores. No user-visible change.
- **Milestone 9 — automatic backups of your notes *and* your data (operational).** The worker now
  produces scheduled backups that capture **both** durable stores in one set: a consistent PostgreSQL
  dump and an archive of your Markdown notes, together with a manifest of file sizes and checksums.
  Each set is verified before it is kept, so a partial or damaged backup is never mistaken for a good
  one. Operators can run or check a backup by hand with the new **`atlas-backup`** command
  (`run` | `verify` | `list`), and set where backups go (`BACKUP_DIR`) and how many to keep
  (`BACKUP_RETAIN`, default 7). No secrets are written to the manifest or logs. Restoring from a
  backup is still the M9-02 drill, so no restore is claimed here. See ADR-0041 and `OPERATIONS.md` §1.
- **Milestone 8 — choose when reminders arrive.** On the **Notifications** page you can now set your
  default reminder timing — how many days before a task is due and at what local time — and override it
  for a single task. Changing the default reschedules the reminders of the tasks that use it; clearing
  it cancels them; clearing a task's override returns it to your default.
- **Milestone 8 — desktop notifications you can turn on.** Atlas can now deliver a **desktop
  notification** when a reminder is due — even when the Atlas tab is closed. A new **Notifications**
  page explains it, asks for permission, registers this browser and lets you turn it off again; it
  clearly reports when notifications are unsupported, blocked in the browser, or unavailable because
  the server has no push keys. Delivery goes through your browser's push service (Web Push/VAPID), the
  signing key stays on the server, and a destination the push service reports as gone is disabled so it
  is never retried. **Note:** real delivery requires the operator to configure VAPID keys; without them
  the page shows "not available" and nothing is sent.
- **Milestone 8 — push-destination registry (internal; no user-visible change yet).** Atlas can now
  remember where to send a notification for each account: a registered **device/push destination** per
  channel (a Web Push subscription for the browser, or a native push token for a phone). Re-registering
  the same destination updates it rather than duplicating, a destination the provider reports as
  invalid/expired is disabled and never retried, and a re-register revives it. The subscription's
  client keys are stored only to send and are never returned or logged. Nothing sends yet (Web Push is
  M8-02, mobile push is M8-04), so there is **no user-visible change in this release** and no new
  dependency.
- **Milestone 8 — durable reminder scheduler (internal; no user-visible change yet).** The backend
  now owns reminder scheduling and durable state: per-user reminder preferences
  (`reminder_policies`), a scheduled reminder per entity (`reminders`) and an at-most-once delivery
  record (`reminder_deliveries`). A reminder fires **exactly once** at the time-zone-correct instant
  through the durable job queue, survives a worker restart, is never delivered twice after a retry,
  is **skipped** for a cancelled/completed/archived/deleted task, and **reschedules** when a due date
  changes. Delivery is behind a small notifier interface (a logging notifier by default); real Web
  Push is M8-02 and per-task timing is surfaced in M8-05, so nothing is user-visible yet. No API
  change. See ADR-0037.
- **Milestone 7 — failure-mode end-to-end tests (internal; test-only, no user-visible change).**
  Playwright is now set up for the web app (`apps/web`, run with `npm run e2e`), and a deterministic
  Chromium suite exercises the offline/sync **failure modes** against the real UI: losing the network
  (a queued edit is kept and flushes when the connection returns), reloading the page mid-sync (the
  pending edit survives and still syncs), and a stale-client conflict (a `409` is surfaced and both
  *Keep mine* / *Take server* actions behave as documented). The API is mocked, so the suite needs no
  live backend and no real account. This adds a **test-only** dev dependency (`@playwright/test`,
  Apache-2.0) plus a downloaded Chromium build; it does **not** ship in the app and changes no runtime
  behaviour. It is a **separate command** — not wired into `scripts/verify.sh` (see `docs/TESTING.md`).
- **Milestone 7 — a clear sync status, and you can resolve conflicts yourself.** The *Sync* page now
  shows one overall state at a glance — **Up to date / Syncing / Offline / Sync error / Conflicts** —
  together with how many changes are pending, failed or conflicting, the exact changes still waiting,
  and any item that conflicts with the server. When an item conflicts you can now decide what to keep:
  **Keep mine** sends your edit again on top of the server's latest version (your change is kept, and
  it is never lost — if the server moved on again you will simply be shown the conflict anew), or
  **Take server** discards your local edit and keeps the server's version. Resolving is safe to repeat:
  doing it twice changes nothing. The panel and its actions work by keyboard and in light and dark
  themes.
- **Milestone 7 — changes you make offline are kept on your device.** Edits made while offline (or
  before a request lands) are now stored **durably** on the device — in IndexedDB, with a
  `localStorage` fallback — so they **survive a page reload** and are replayed to the server when the
  connection returns. Each queued change remembers the item it targets, what changed, the revision it
  was based on, and a one-time key, so replaying it can **never duplicate** the change. If an item
  changed on the server in the meantime, the stale edit is **kept and surfaced, never silently
  overwritten**. The client also pulls updates through the change feed from a stored cursor, and when
  its cursor has fallen behind the retained history it performs a full resync instead of a partial
  update. A new **Sync** page (navigation → *Sync*) shows how many changes are waiting and their
  state. This is the first user-visible surface of the sync work (the fuller status UI and reconnect
  reconciliation are M7-04/M7-05); the only new dependency is the test-only, MIT-licensed
  `fake-indexeddb` used to exercise the IndexedDB path in tests.
- **Milestone 7 — changes made offline now sync automatically when you reconnect.** When the device
  comes back online, the Sync page is focused again, or you press *Sync now*, Atlas replays everything
  you queued while offline and then catches up on changes made elsewhere, applying them to a local
  cache so the app converges. If an item changed on the server in the meantime, your edit is **kept and
  shown** in a *Sync conflicts* panel — it is never silently dropped and never overwrites the newer
  server copy; choosing which to keep is a follow-up step. If the device has been offline longer than
  the server keeps change history, the client performs a full resync instead of a partial one. Syncing
  is safe to repeat and never duplicates a change. This is the reconnect-reconciliation work (M7-04);
  the fuller pending/failed/conflicts status UI and manual resolution are next (M7-05). No new
  dependency was added.
- **Milestone 7 — a bounded tombstone retention window (internal; sync safety).** The change feed's
  deletion history is now bounded by a configurable **retention window** (default 30 days). A durable,
  restart-safe background purge removes only *old change-feed entries* — it never deletes your tasks,
  projects or notes, and a deleted item stays a recoverable tombstone. So that a deletion can never be
  silently missed, a device whose sync cursor has fallen behind the retained history (older than the
  window) is now told `resync_required` and performs a full resync instead of being handed a partial
  update that could resurrect a deleted item. The new `resync_required` field defaults to `false`, so
  nothing changes for a client that is up to date. Nothing consumes it yet (the offline client
  queue/UI are M7-03/M7-04), so there is **no user-visible change in this release** and no new
  dependency.
- **Milestone 7 — a single per-user change feed (internal; sync foundation).** A new `GET /api/changes`
  endpoint lets a client that already holds a cursor pull *everything that changed since* — tasks,
  projects, note metadata and note↔project links, including deletions (tombstones) — ordered by one
  monotonic per-user cursor, so a device converges incrementally instead of re-downloading everything.
  An entity changed twice between two pulls appears once, at its latest change, and paging on the
  returned `next_since` sees the whole change set exactly once. It is read-only and strictly scoped to
  your account. Nothing consumes it yet (the offline client queue/UI are M7-03/M7-04), so there is
  **no user-visible change in this release** and no new dependency.
- **Milestone 5 — periodic calendar reconciliation (internal; small status improvement).** Atlas now
  runs a durable, scheduled **reconciliation scan** that re-syncs each due calendar from its stored
  cursor, so a change is recovered even if the provider's change notification was lost or never
  delivered — notifications are treated as hints, not a complete change log. The scan runs as a
  durable background job (it survives a worker restart), is idempotent (a repeated scan never
  duplicates an event) and never advances the cursor before its changes commit. A per-calendar
  **running marker** now lets the **Calendar** page report a sync as *in progress* while it runs; a
  marker left by a crashed run is treated as stale and never shown as live. Everything is scoped to
  your own account; no real provider is contacted yet (M5-03/M5-04 pending), so there is **no new
  dependency** and no change for an account with nothing connected.
- **Milestone 5 — calendar sync status you can see (and retry).** The **Calendar** page now shows the
  health of your calendar connection: for each connected provider, the last successful sync, whether
  it is up to date or has failed, and the last error; a per-provider **Sync now** button retries a
  sync, and a failed status can be reloaded. Two authenticated endpoints back it —
  `GET /api/calendar/sync-status` (the status derived from the sync state, per provider/calendar,
  with a safe error message that never includes tokens, ciphertext or event contents) and
  `POST /api/calendar/providers/{provider}/sync` (a read-only, idempotent sync trigger — repeating it
  never duplicates an event). Connecting a Google or Microsoft account and viewing events are still
  to come (M5-03/M5-04/M5-05/M5-07), so with nothing connected the page says so and a provider with no
  adapter yet is reported clearly; no new dependency is added.
- **Milestone 5 — event projection store + safe sync cursors (internal; no user-visible change).**
  Atlas can now persist the calendar events it reads from a provider as a **projection** and track a
  **per-calendar sync cursor** so each sync fetches only what changed. The cursor is advanced **only
  in the same committed transaction** as the changes it covers, so a crash or a failed sync can never
  skip an event — a retry simply re-fetches it. A provider deletion is recorded as a tombstone, never
  a hard delete of your data, and every sync is strictly scoped to your own account. This is the
  storage/synchronisation layer behind the calendar integration; it is exercised against an in-memory
  fake adapter and a real database only (the real Google/Microsoft adapters are still to come, M5-03/
  M5-04), so there is **no user-visible behaviour change in this release** and **no new dependency**.
- **Milestone 5 — calendar adapter interface (internal; no user-visible change).** Atlas now defines a
  single, **provider-neutral contract** that the Google and Microsoft calendar integrations will both
  implement, together with the internal calendar/event model (time zones, all-day and recurring
  events, deletions/tombstones), a pagination + incremental-sync cursor model and an error taxonomy
  that lets the synchroniser retry, back off or request re-authentication without knowing which
  provider it is talking to. This is groundwork for the calendar integration and adds **no
  dependency**; it does not yet connect to Google or Microsoft, so there is **no user-visible
  behaviour change in this release**.
- **Milestone 5 — encrypted credential store (internal; no user-visible change yet).** Atlas can now
  store the OAuth credentials it will use to read your Google and Microsoft calendars. Each account's
  tokens are **encrypted at rest** (AES-256-GCM) with a key held outside the database; the key version
  is recorded so it can be rotated. Tokens are never returned by the API, and are redacted from logs
  and errors. This is the security foundation for the calendar integration — connecting an account and
  viewing calendars is still to come (M5-02 onward), so there is **no user-visible behaviour change in
  this release** beyond the new, authenticated `/api/calendar/credentials` endpoints.
- **Milestone 4 — export your projects and tasks.** Your projects, their tasks and the notes linked
  to them can now be exported as one open, machine-readable JSON document (data portability,
  REQ-015).
  - `GET /api/projects/export` exports all of your projects; `GET /api/projects/{id}/export` exports
    a single one (a project that does not exist, is not yours, or has been deleted is reported as
    `404`).
  - The document is **versioned and self-describing**: it names its format (`atlas.project-export`)
    and version, so a tool written today can keep reading future exports. Each project includes its
    name, description, status, dates and derived progress, its tasks (with stable ids, status,
    priority, dates, time zone, recurrence and revision), and the notes linked to it. Timestamps
    are ISO-8601 in UTC; dates are `YYYY-MM-DD`.
  - The export is faithful and self-consistent: it is taken as a single snapshot, so a change made
    while it runs cannot leave it half-updated.
  - It is strictly private to your account and covers only **current** data — projects, tasks and
    notes you have deleted are not included. An account with no projects exports a valid, empty
    document.
  - Large accounts are bounded: `limit` (up to 500, default 200) caps how many projects are
    exported, and the document's `truncated` flag tells you when more remain, so nothing is dropped
    silently.
- **Milestone 4 — day and week planning views.** Two new views in the navigation plan your work one
  local day or one whole week at a time.
  - **Day** (`/day`) shows a single day, with *Previous day* / *Today* / *Next day* navigation. The
    current day uses the same server-derived "today" as the Today view — work that is overdue plus
    what is due today — while any other day lists what is due on it. Tasks are placed on the day they
    are actually due **in your time zone**, so a deadline at 23:30 UTC appears on the next day for a
    viewer in Berlin.
  - **Week** (`/week`) shows the seven days of the week (Monday first) with *Previous week* /
    *This week* / *Next week* navigation. Days with nothing planned still render, so the week keeps
    its shape and you can see where the gaps are.
  - Both views show **project context**: a task that belongs to a project is tagged with the project's
    name, and the projects a plan touches are summarised with the project's progress (the same
    derived figure the project itself reports).
  - Plans list open work only (Inbox, Next, In progress) and read the same task data as the rest of
    Atlas, so nothing is duplicated or re-computed in the browser. Empty days and empty weeks explain
    themselves, a failure to load shows a clear message with a *Try again*, and a failure to load the
    project names does not hide your plan.
  - Completed and archived tasks stay out of a plan, the views are keyboard-accessible, work in both
    light and dark themes, and the week collapses to a single column on a narrow screen.
- **Milestone 4 — note ↔ project links.** A note can now be linked to a project, and a project's
  notes (or a note's projects) can be listed.
  - `PUT /api/projects/{id}/notes/{note_id}` links a note; `DELETE` on the same path unlinks it.
    Both are idempotent (repeating them changes nothing) and return `204`.
  - `GET /api/projects/{id}/notes` lists a project's notes in path order; `GET
    /api/notes/{id}/projects` lists the projects a note belongs to.
  - The link is stored against the note's **stable identity**, so renaming or moving a note keeps it
    linked — only the note's path changes.
  - Links are optional and many-to-many (a note can belong to several projects), and are private to
    your account: a project or note that does not exist, belongs to another account, or has been
    deleted is reported as `404` and changes nothing.
  - Deleting a note or a project removes its links; neither a note nor a project is ever deleted
    because of the other.
- **Milestone 4 — project progress.** Every project now reports its **progress** — how much of its
  work is done — on every project response (`progress: {total, completed, percent}`).
  - The figure is derived from the project's tasks on each read and is never stored: `total` counts
    the project's live tasks that are not archived, `completed` counts those with status `completed`,
    and `percent` is that fraction rounded to the nearest whole percent (halves rounded up).
  - Deleted tasks, archived tasks, and tasks filed under another project (or none) never count. A
    project with no tasks reports `0/0` and `0%` — it is never treated as complete.
  - Listing many projects stays fast: progress for the whole list is computed in a single grouped
    query rather than one query per project.
- **Milestone 4 — Kanban board.** A new **Board** in the navigation (route `/board`) shows your tasks
  in five columns — Inbox, Next, In progress, Completed and Archived — that are exactly the task
  statuses.
  - Drag a card to another column, or pick a status from the card's menu, to move the task. The move
    is saved with the task's revision, so it syncs to your other devices like any other edit.
  - Only the transitions Atlas allows are offered: the status menu disables a status a task cannot
    move to, and a card cannot be dropped there either. If the server still rejects a move — because
    the task changed elsewhere, or the transition is not allowed — a clear message appears and the
    card stays where it was; a rejected move is never ignored silently.
  - Columns show a placeholder when empty, and the board shows a hint when you have no tasks yet.
    The board works in both light and dark themes.
- **Milestone 4 — task ↔ project association.** A task can now be filed under a project, and a
  project's tasks can be listed.
  - Give a task a `project_id` when you create it, and move it between projects — or unfile it by
    sending `project_id: null` — with `PATCH /api/tasks/{id}`. Membership is always optional: a
    task with no project behaves exactly as before.
  - `GET /api/projects/{id}/tasks` lists a project's tasks, with the same task shape and ordering as
    `GET /api/tasks?project_id={id}`. It reports a project that does not exist, belongs to another
    account, or has been deleted as `404`. The `project_id` filter on `GET /api/tasks` is unchanged.
  - Assigning a task to a project that does not exist, is not yours, or has been deleted is rejected
    with `400` and changes nothing.
  - Deleting a project still never deletes your tasks: the project disappears and the tasks filed
    under it simply become unfiled (everything else about them is kept, and the change syncs to your
    other devices like any other edit). Tasks that are already deleted are left untouched. A deleted
    project cannot be assigned to again, and its tasks are no longer matched by a filter on it.
  - A subtask keeps sharing its parent's project, so moving a subtask to a different project is
    rejected.
- **Milestone 4 — projects.** Projects are now first-class entities you can create, read, update
  and remove.
  - `POST /api/projects`, `GET /api/projects`, `GET /api/projects/{id}`, `PATCH
    /api/projects/{id}` and `DELETE /api/projects/{id}`. A project has a name, an optional
    description, a status (`active`/`completed`/`archived`) and optional start/target dates.
  - Removing a project is a soft delete: it disappears from the API but the record is retained so
    the removal can propagate. Tasks are never deleted with a project — a task simply loses its
    project association.
  - Updates are revision-aware: send the `base_revision` you edited from and a stale write is
    rejected with `409` instead of overwriting newer changes. Mutations accept an optional
    `Idempotency-Key` and a retry returns the original result.
  - Invalid input (an empty name, an unknown status, a start date after the target date, a
    malformed date) is rejected with `400`/`422` and changes nothing. Projects are strictly
    private to your account. A task can only reference a project you own.
- **Milestone 3 — task change log (incremental pull).**
  - `GET /api/tasks/changes?since=<revision>&limit=<n>` returns only the tasks changed after the
    revision you already hold, in ascending revision order, **including deleted tasks as tombstones**
    (a non-null `deleted_at`) so a client can drop them locally and converge without re-downloading
    the whole list.
  - The response carries a new high-water mark (`next_since`) and `has_more`; page with
    `since=next_since` until `has_more` is false to see every change exactly once, with no gaps or
    duplicates (a task changed twice between pulls appears once, at its latest revision).
  - `since` (0…2147483647) and `limit` (1…500, default 200) are validated; an invalid value is
    rejected with `422` and changes nothing. The feed is read-only and shows only your own tasks.
- **Milestone 3 — task search and filters.**
  - `GET /api/tasks` accepts filters that combine freely with each other and with the views and
    subtask listing: `status` (repeated or comma-separated), `priority`, an inclusive
    `due_from`/`due_to` range on the due date, an inclusive `start_from`/`start_to` range on the
    start date, and `project_id`. A date-only bound covers the whole day.
  - Text search with `q` matches task titles and descriptions, ignoring case. `%` and `_` are
    matched literally, and the term is limited to 200 characters.
  - Filtered results are ordered most urgent first and then by the earliest due date; an unfiltered
    list keeps its original order. `limit` (default 200, maximum 500) caps the response.
  - Invalid filters — an unknown status or priority, a malformed or inverted date range, a
    malformed project id, an empty or over-long search term, an out-of-range limit — are rejected
    with `422` and change nothing.
- **Milestone 3 — Inbox, Today and Upcoming views.**
  - Working **Today** (the landing page), **Inbox** and **Upcoming** views, reachable from the
    primary navigation. Each view renders the server's response and shows a clear empty state, or
    an error with a retry.
  - **Quick capture** adds a task from a title alone, from Today and Inbox.
  - **Today** lists overdue and due-today work separately. **Upcoming** groups tasks by the day they
    are due. Completed and archived tasks do not appear in either.
  - Tasks can be completed from any of the three views.
  - `GET /api/tasks` now accepts a `view` (`inbox`/`today`/`upcoming`) and a `tz` (IANA) query
    parameter, and every task reports a derived `due_state`
    (`none`/`overdue`/`today`/`upcoming`). "Today" is the caller's calendar day for a task that has
    no time zone of its own, and the task's own zone when it has one.
- **Milestone 3 — recurring tasks.**
  - Tasks can repeat on a standard RFC 5545 schedule (for example `FREQ=WEEKLY;BYDAY=MO,WE,FR`) with
    an optional `COUNT`/`UNTIL` end. A recurrence is anchored on the task's start or due date.
  - Completing a recurring occurrence completes only that occurrence and creates the next one; the
    series and its other occurrences are never completed or deleted. Occurrences keep their
    wall-clock time (for example 09:30) across daylight-saving changes.
  - A retried completion (same `Idempotency-Key`) never creates a duplicate occurrence.
- **Milestone 3 — subtasks.**
  - A task can become a subtask of another task owned by the same user. Self-parenting, cycles
    (at any depth), cross-user parents and missing or deleted parents are rejected, and a subtask
    shares its parent's project.
  - `GET /api/tasks?parent_task_id=…` lists a task's direct subtasks, and every task reports a
    derived `subtasks_done` / `subtasks_total` count. Completing every subtask does **not**
    complete the parent.
  - Deleting a parent promotes its subtasks to top-level tasks instead of orphaning them.
  - Completing a recurring task does not copy its subtasks to the next occurrence.
- **Milestone 2 — Markdown notes.**
  - Notes are real Markdown files under the configured notes root: create, edit, rename, move and
    delete (deletions move to a recoverable trash folder, never `rm`).
  - Revision-aware API: every note carries a revision; a stale write or an external file change is
    rejected with `409` and never overwrites. Conflicting versions can be kept as `(conflict …)`
    copies.
  - Folder navigation with create/rename/delete; renaming a folder or note keeps note identity,
    wiki links and backlinks intact.
  - Full-text search over note titles and content (PostgreSQL FTS).
  - Tags, `[[wiki links]]`, backlinks and unresolved-link reporting.
  - External-file reconciliation: a worker job scans the notes root and re-indexes changes
    (default every 5 minutes), plus a manual `POST /api/notes/reconcile`.
  - Notes UI: folder tree, Markdown source editor (CodeMirror) with rendered preview, search,
    links/backlinks panel and inline conflict resolution. The editor bundle is lazy-loaded.
- **Milestone 1 — foundation and secure deployment (partial).**
  - Backend: FastAPI application with structured JSON logging (secret-redacting), `/health` and
    `/health/ready` endpoints, and security headers.
  - Authentication: first-run account setup, login/logout, Argon2id password hashing, server-side
    sessions, CSRF protection and auth rate limiting.
  - Database: SQLAlchemy models and the initial Alembic migration for users, sessions and jobs.
  - Durable PostgreSQL job queue (enqueue / claim / retry-with-backoff / complete) and a worker
    process.
  - Web client: React + TypeScript shell with navigation, light/dark theme, first-run setup and
    login, gated behind authentication; API types generated from the OpenAPI schema.
  - Deployment: Docker Compose for `web`, `api`, `worker` and `db` with persistent volumes.
  - CI: documentation/hygiene checks plus backend (ruff, mypy, pytest) and frontend
    (eslint, tsc, vitest, build) jobs.
- **Milestone 0 — project documentation.** Product specification, architecture, data model,
  decision records, risk register, roadmap/backlog, security, testing, Markdown storage, calendar
  synchronisation, deployment, operations, dependencies and acceptance record.

### Changed
- Nothing yet.

### Fixed
- **Developer/CI:** the frontend component tests now run under `NODE_ENV=test`. An inherited
  `NODE_ENV=production` previously made React 19 resolve its production build (which has no
  `act`), so every `render()` failed with `TypeError: React.act is not a function`; the vitest
  config now pins the test environment (`apps/web/vite.config.ts`). No tests were weakened.
- **Security:** structured logging now redacts sensitive top-level fields (`password`,
  `refresh_token`, `authorization`, …) — previously only nested values were redacted.
- **Security:** login rejects unknown accounts with the same cost and response as a wrong
  password, removing a user-enumeration timing side channel.
- **Security:** upgraded `vitest` and `pytest` to versions without known advisories; `npm audit`
  and `pip-audit` are now enforced in CI.
- **Security:** interactive API docs are disabled in production; API responses are sent with
  `Cache-Control: no-store`; an optional `ALLOWED_HOSTS` allow-list is available.
- `atlas-migrate` now resolves `alembic.ini` in both editable and installed layouts, so the
  containerised API applies migrations on startup.
- The background worker survives transient database errors (for example, starting before the
  schema exists) instead of exiting, and starts only after the API is healthy.
- The generated OpenAPI type file (`apps/web/src/api/schema.d.ts`) is now committed; a clean
  checkout and the web container build previously failed with `TS2307`. CI checks it stays in
  sync with the API.

### Removed
- Nothing yet.

<!--
Notes and tasks are not yet implemented; this changelog tracks user-visible behaviour.
Do not list planned features here.
-->
