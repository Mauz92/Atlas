# UX/UI Audit — Atlas web app (2026-11-02)

Status: **proposal, not approved.** The audit was read-only: nothing under `apps/web` was changed. It
is the input for a possible UX milestone. It adds no new requirement until the owner approves it and
the tasks below are copied into `ROADMAP.md`.

**How it was done.** I read `AGENTS.md`, `PRODUCT_SPEC.md` §1.1, the `ROADMAP.md` MU section, ADR-0043,
`apps/web/src/styles.css`, `Layout.tsx`, `lib/navigation.ts`, `lib/theme.ts`, `main.tsx`, `NoteEditor.tsx`,
`TaskList.tsx` and the page components. I then ran a separate real stack: a throwaway database
(`atlas_e2e_uxaudit_caa2ecd8`), its own API on :8371 with a temporary notes directory, and its own Vite on
:5301 with its own dependency cache. I seeded it through the real API with fictional data: 25 tasks, 4
subtasks, 2 recurring tasks, tags, 3 projects with progress, 12 notes in nested folders and a daily note.
Playwright captured 20 routes and states at 1440×900, 1024×768 and 390×844, in light and dark (132 PNGs).
axe-core (already in `node_modules`) ran WCAG 2 A/AA checks on 10 routes in both themes. Afterwards the
stack was torn down and the database dropped.

Screenshots are named `<state>_<desktop|laptop|mobile>_<light|dark>.png` and are in
`/tmp/claude-1000/-home-kim-Documents-Atlas/31ff7fb3-5923-481a-b611-5657fde6b6ea/scratchpad/ux-audit/shots/`.
They are session scratch files, not repository artefacts, so re-run the capture to regenerate them.

**Caveat: a moving target.** MU-08 was editing `apps/web/src` during the audit. The audit served the
working tree, so the screenshots mix pre-MU-08 and in-progress MU-08 states. For example, the accent was
`#3b6ef5` in the early shots and `#2c5ce0` by the time the Settings shots were taken, and the horizontally
scrolling mobile nav is MU-08 work. The root causes below are structural, and MU-08 does not remove them.

---

## 1. Verdict — why it feels messy

Atlas works, but it looks like **a set of feature demos that share a stylesheet**, not one tool. These are
the five root causes, in order of how much they contribute:

1. **No information architecture: 14 flat, equal-weight nav items plus projects mixed in.**
   `lib/navigation.ts` lists Today, Inbox, Upcoming, Day, Week, Tasks, Board, Projects, Calendar, Sync,
   Notifications, Notes, Search and Settings at the same level. Active projects are injected between
   Projects and Calendar (`Layout.tsx` `SidebarProjects`). Four of these are status or settings screens
   (Sync, Calendar, Notifications, Search), and Day mostly duplicates Today (compare `day_desktop_light.png`
   with `today_desktop_light.png`: same Overdue and Due-today sections). Notes, which `PRODUCT_SPEC` §1.1
   calls "the centre", is item 12. On the project page, *Projects* and *Website relaunch* are both
   highlighted solid blue (`project-page_desktop_light.png`). On mobile the 14 items become a sideways
   scrolling strip (`today_mobile_light.png`).
2. **Every control is a full-weight button, so there is no visual hierarchy.** The default `button` is
   solid accent (`styles.css` `button {…}`), and the only other variant is `.ghost` (bordered). The result:
   - Every task row ends in a bordered **"Complete"** button instead of a checkbox (`today_*`,
     `upcoming_*`, `week_*`).
   - Inbox rows carry six controls: Today, Tomorrow, date picker, File-to select, Delete, Complete
     (`inbox_desktop_light.png`). On mobile that stacks into a 2,746 px page for 9 items
     (`inbox_mobile_light.png`).
   - Week and Day use three solid-blue nav buttons (`week_desktop_light.png`).
   - Board cards each carry a full-width `<select>` (`board_desktop_light.png`, 2,000 px tall).
   - Disabled primary buttons are 60 % opacity accent, which reads as "broken", not "unavailable"
     (*Add*, *Save*).
3. **No design system: two semantic tokens, ad-hoc sizes everywhere.** `:root` defines only `bg`,
   `surface`, `border`, `text`, `muted`, `accent` and `danger`, plus one `--space` and one `--radius`.
   `styles.css` has 45 `font-size` declarations with 13 distinct values (0.7 to 1.4 rem, plus a raw
   `15px`), 7 different `gap` values and 20+ padding combinations. There are five copies of the same pill
   (`.badge`, `.sync-badge`, `.offline-queue-badge`, `.notification-badge`, `.sync-panel-badge`) and four
   copies of the uppercase section heading (`.view-section h2`, `.notes-links h2`, `.project-summary h2`,
   `.board-column-header h2`). Further gaps:
   - No elevation scale, no warning or success colour, no hover or selected tokens.
   - All priorities render as the same grey pill (`URGENT` looks like `LOW`).
   - Form controls are half-styled. `input` applies 10 px padding to every input type, including
     checkboxes. `textarea` has no base rule, so it renders as a native grey box in dark mode
     (`task-detail_mobile_dark.png`). `<progress>` uses the browser's blue, not the accent
     (`projects_desktop_light.png`).
   - Dates use two formats: "Wed 4 Nov" in lists and "2026-10-13" on the project page
     (`project-page_desktop_light.png`).
4. **Pages are forms, not workspaces, and Notes suffers most.**
   - `/notes` puts a second bordered sidebar (search, path field, New note, New folder, template select,
     New from template, Today's note, then the tree) inside the app sidebar. The editor and preview are
     then split 50/50 with `max-height: 60vh` (`.editor-host`, `.markdown-preview`). At 1024 px the
     editor gets about 220 px, roughly 27 characters per line (`notes-open_laptop_light.png`).
   - Developer metadata is shown to the user ("Talks/…/Outline.md · revision 1").
   - `[[links]]` are not rendered as links in the preview.
   - In dark mode the CodeMirror gutter stays light grey (`notes-open_desktop_dark.png`) because
     `NoteEditor.tsx` passes no editor theme.
   - On mobile the tree pushes the editor below 1,100 px (`notes-open_mobile_dark.png`).
   - Today's daily-note preview prints flattened raw Markdown ("## Focus - Finish…", `today_desktop_light.png`).
5. **Chrome that does not earn its space, and theming done in JavaScript.**
   - The topbar spends 70 px on the user's name and three text buttons: "Search · Ctrl K", "Dark",
     "Sign out".
   - Sync state, the one signal a local-first app must always show, lives on its own page. That page
     says the same thing three times ("Up to date", "All synced", "You are up to date", `sync_desktop_dark.png`).
   - The task detail is a 420 px sheet with no backdrop. It covers the list it edits and shows 12
     identical label-over-field blocks. Status is "In progress" but priority is lowercase "high", time
     zone is a free-text field, and *Save* sits below the fold (`task-detail_desktop_light.png`).
   - Dark mode exists only as `:root[data-theme="dark"]`, set by `ThemeToggle` inside the authenticated
     shell. As a result, **the login and setup screens are always light, even under a dark OS theme**
     (`login_desktop_dark.png`), and dark-OS users get a light flash before the shell mounts. No
     `prefers-color-scheme` rule exists in CSS (`main.tsx`, `lib/theme.ts`).

Also seen, which may be product issues rather than styling:

- Subtasks ("Demo script", "Q&A prep") appear as top-level rows in Inbox, Tasks and Board with no parent
  context.
- The project page lists completed tasks with a "Complete" button (`project-page_desktop_light.png`).

## 2. What to take from the reference apps (translated to Atlas)

Everything below stays within AGENTS.md §15: no plugins, no new stores, and notes remain Markdown files.

| Reference pattern | Atlas pattern |
|---|---|
| **VS Code activity bar** (icon rail, one active "view container") | 48 px left rail with 5 destinations: **Home** (Today), **Tasks**, **Projects**, **Notes**, **Search**. **Settings** sits at the bottom and opens a page whose sections include Sync, Calendar and Notifications. The rail chooses what the sidebar shows. |
| **Obsidian file explorer / Notion sidebar with collapsible sections** | 260 px collapsible sidebar (Ctrl+B) whose content depends on the rail. *Tasks*: Today, Inbox (count), Upcoming, Week, All tasks, saved filters. *Projects*: active projects with mini progress. *Notes*: the folder tree with chevrons, hover "+" and "…" on rows, Daily note pinned on top. New note and New folder move to the section header icons and the palette, out of the tree panel. |
| **Obsidian minimal chrome, Markdown-first** | Remove the topbar. The page header shows the title and the page's own actions, and the editor takes the full main area with a 72 ch measure. A **live-preview mode** (CodeMirror decorations, as allowed by D-2) toggles with Source and Split (Ctrl+E). It does not change the stored file. |
| **Obsidian tabs/panes** | Phase 2, optional: the note opened last stays in a "recent" list in the palette. Multi-tab editing is **not** proposed now (§15), because it adds state and conflict surface. |
| **Notion typographic hierarchy** | One type scale (§3). Page titles are 28/600. Section labels are 12/600 in muted colour, sentence case, not uppercase. Metadata uses the secondary text colour. |
| **Notion hover affordances** | Row actions (schedule, project, delete, open) appear on hover or focus as 28 px icon buttons. On touch they move into a "…" menu or a swipe-free action sheet. The completion checkbox is always visible. |
| **Notion slash menu** | In the editor, `/` at the start of a line offers heading, list, checkbox, code block, table, `[[link]]`, "Create task from line" and "Insert template". It inserts plain Markdown text only. |
| **VS Code command palette** | Keep it (it is already the best surface, `palette_desktop_dark.png`). Add a `>` prefix for commands and show shortcuts on the right. Recent items appear when the query is empty, and project or status show as secondary text. |
| **VS Code status bar** | A 24 px bottom bar showing sync state (●  Synced / Offline · 3 queued / Conflicts 1, which opens the Sync section), calendar sync age, the current note's word count and saved state, and `?` for the shortcut help. This replaces the Sync nav item. |
| **VS Code density, keyboard-first** | 32 px rows (28 px compact). In lists, `j`/`k` move, `x` completes, `e` or Enter opens detail, `t`/`m` set today or tomorrow, `p` files to a project, and `#` sets priority. The help overlay (MU-08) is the index. |

## 3. Proposed design system

**Principles.** Neutral surfaces, one accent, colour only for meaning (priority, state, danger). Density
comes from spacing, not borders. Borders separate *regions*, never every row.

### 3.1 Colour tokens

Contrast ratios were computed against the stated background.

| Token | Light | Dark | Use / ratio |
|---|---|---|---|
| `--bg` | `#ffffff` | `#18181b` | main area |
| `--bg-sidebar` | `#f7f7f8` | `#131316` | rail and sidebar |
| `--bg-raised` | `#ffffff` | `#232327` | panels, popovers, palette |
| `--bg-hover` | `#f0f0f2` | `#26262b` | row hover |
| `--bg-selected` | `#e8e8ec` | `#2e2e34` | selected row or nav (not accent) |
| `--border` | `#e7e7ea` | `#2a2a2f` | region dividers |
| `--border-control` | `#8a8a93` | `#6e6e78` | input and checkbox outline (3.42 / 3.51 : 1, WCAG 1.4.11) |
| `--text` | `#1f1f23` | `#e7e7ea` | 16.4 / 14.4 : 1 |
| `--text-2` | `#52525b` | `#a1a1aa` | secondary, 7.7 / 6.9 : 1 |
| `--text-3` | `#71717a` | `#8b8b94` | meta and placeholder, ≥ 4.5 : 1 on all bgs |
| `--accent` | `#4f46e5` | `#818cf8` | primary button bg; white text 6.3 : 1; dark uses `#111118` text 6.3 : 1 |
| `--accent-hover` | `#4338ca` | `#a5b4fc` | |
| `--accent-text` | `#4338ca` | `#a5b4fc` | links, focus ring (7.9 / 8.9 : 1) |
| `--accent-soft` | `#eef0ff` | `#26264a` | active nav item, selected palette row |
| `--danger` | `#c42b1c` | `#ff8a80` | 5.7 / 7.8 : 1 |
| `--warning` | `#a15c00` | `#f0b45b` | overdue, priority high |
| `--success` | `#1a7f37` | `#5fd38a` | synced, completed |
| `--prio-urgent` / `high` / `medium` / `low` | danger / warning / accent-text / text-3 | same mapping | small flag icon plus text, not a pill |

The single accent is indigo, which gives a more distinctive identity than the current generic blue. Any
single hue works, and this is Q1 below. Dark mode is defined in CSS by
`@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {…} }` plus
`:root[data-theme="dark"]`, so it also applies before login. An inline `<script>` in `index.html` sets
`data-theme` from `localStorage` before first paint. Theme options are **System** (default), Light and
Dark.

### 3.2 Type, spacing, shape

- **Fonts:** `--font-ui: system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif;` and
  `--font-mono: ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace;`. There is **no web
  font and no CDN**, so no extra requests or telemetry. Note prose uses `--font-ui` in live preview, and
  source mode uses `--font-mono`.
- **Type scale (px / line-height / weight):**

  | Step | Use | Size / line-height | Weight |
  |---|---|---|---|
  | `xs` | badges, kbd | 11 / 16 | — |
  | `sm` | meta, labels | 12 / 16 | — |
  | `base` | UI | 14 / 20 | — |
  | `md` | note body | 16 / 26 | — |
  | `lg` | section title | 18 / 24 | 600 |
  | `xl` | page title | 24 / 32 | 600 |
  | `2xl` | note H1 | 28 / 36 | 650 |

  The UI base is 14 px, like VS Code, Linear and Notion; it is 15 px today. **No other font-size value is
  allowed in CSS.**
- **Spacing:** 4-pt scale `--s-1:4px --s-2:8px --s-3:12px --s-4:16px --s-5:24px --s-6:32px --s-7:48px`.
- **Radius:** `--r-sm:4px` (badges, kbd), `--r-md:6px` (buttons, inputs, rows), `--r-lg:10px` (panels,
  palette).
- **Elevation:** `--shadow-1: 0 1px 2px rgb(0 0 0/.06)` for menus, `--shadow-2: 0 8px 24px rgb(0 0 0/.14)`
  for the sheet, and `--shadow-3: 0 16px 48px rgb(0 0 0/.24)` for the palette. Dark mode uses the same
  shadows plus a 1 px `--border` outline.
- **Density:** row height `--row: 32px` (default) or 28 px (compact, a Settings toggle stored per browser).
  Controls are 32 px, or 28 px when small. Touch targets are ≥ 44 px under `(pointer: coarse)`.
- **Motion:** 120 ms ease-out for hover and sheet transitions, disabled under `prefers-reduced-motion`.

### 3.3 Iconography

**Recommendation: no runtime dependency.** Vendor about 25 icons from **Lucide** (ISC licence, a
permissive MIT-style licence that allows commercial use, requires keeping the notice, and has no
service). They go into one `src/components/Icon.tsx` as inline `<svg>` paths: 24 px viewBox, 1.75 stroke,
`currentColor`. The ISC notice and version go in `DEPENDENCIES.md`.

Icon set: sun (Today), inbox, calendar-days, check-square (Tasks), folder-kanban (Projects), file-text,
folder, folder-open, chevron-right, search, settings, plus, more-horizontal, check, x, flag, tag, repeat,
link, cloud, cloud-off, alert-triangle, panel-left, panel-right and keyboard.

Adding `lucide-react` instead would be acceptable (ISC, maintained), but it pulls in 1,500 icons for the
25 we need. This is Q3.

### 3.4 Component inventory

Plain React plus CSS classes in `styles.css`, split into sections or `@layer`s. No UI framework.

| Component | Spec |
|---|---|
| **Button** | `primary` (one per view at most), `secondary` (neutral bg, `--border`), `ghost` (no border, hover bg), `danger` (ghost with danger text; filled only inside confirmations), `icon` (28/32 px square, `aria-label` required). Sizes `sm` 28 and `md` 32. Disabled means `--text-3` text on `--bg-hover`, not an opacity change. |
| **Input / Textarea / Select** | One base rule for `input:not([type=checkbox],[type=radio])`, `textarea` and `select`: 32 px height, `--border-control`, and a focus ring of `2px --accent-text`. Inline variant: borderless until hover or focus, for titles in the detail sheet. |
| **Checkbox** | Custom 16 px round checkbox for task completion, square for selection; `accent-color` for native ones. |
| **Tabs / segmented** | Used for List/Board, Source/Live/Split and Settings sections. Underline style, `aria-selected`. |
| **List row** | `[checkbox] title ……… meta (project · due · flag) [hover actions]`, 32 px, no per-row border. Hairline dividers only in dense tables. Overdue dates in `--warning`. Subtask count shown as `2/4` with an icon. |
| **Sidebar item** | 28 px, icon plus label plus optional count. Active means `--accent-soft` bg and `--accent-text`. Collapsible section header is a chevron with 12/600 muted text, plus hover actions. |
| **Panel / Sheet** | Right detail panel, 400 px resizable. On ≥ 1280 px it **docks** and pushes the content. Below that it overlays with a scrim. On mobile it is a full-screen sheet with a sticky header (Back, title, Save state). Escape closes it and focus returns to the row. |
| **Popover / Menu** | One positioned menu for "…", date shortcuts (Today / Tomorrow / Next week / Pick date), project picker and priority picker. It replaces the inline Inbox controls. |
| **Toast** | Bottom-centre (mobile) or bottom-right (desktop), one at a time, with an action (Undo), 6 s timeout and `role="status"`. Reuse `UndoToast`. |
| **Badge / Pill** | One `.pill` with tone modifiers (`neutral`, `accent`, `danger`, `warning`, `success`). It replaces the five copies. Tags appear as `#tag` text in `--text-3`, not pills. |
| **Empty state** | Icon, one sentence and one action button, centred within the section. Never a dashed box with developer wording. |
| **Skeleton** | Three grey 32 px rows with a shimmer (disabled under reduced motion) instead of "Loading today…". |
| **Section header** | `h2` 12/600 `--text-3`, sentence case, count on the right, collapsible on Today. |
| **Status bar item** | 24 px tall, icon plus short text, clickable, `aria-live="polite"` for sync changes. |

## 4. App shell and IA

### 4.1 Desktop (≥ 1024 px)

```
┌──┬────────────────────┬──────────────────────────────────────────┬───────────────────┐
│◉ │ TASKS            ⊕ │ Today                       Mon 2 Nov ⋯  │ Draft talk outline│
│☀ │  ☀ Today        6  │ ┌──────────────────────────────────────┐ │ ○ In progress     │
│▣ │  ▢ Inbox        9  │ │ + Add a task for today…              │ │ ⚑ High  📅 Today  │
│▤ │  ▦ Upcoming        │ └──────────────────────────────────────┘ │   15:00  ↻ none   │
│▧ │  ▦ Week            │ Overdue                               4  │ ▣ Conference talk │
│⌕ │  ☰ All tasks       │ ○ Renew passport      ⚑ admin   Fri 30 ⋯ │ # writing         │
│  │  SAVED FILTERS  ▾  │ ○ Send invoice #2041  ⚑ work   Sun 1  ⋯ │───────────────────│
│  │   High this week   │ Due today                             2  │ Description…      │
│  │ PROJECTS        ▾  │ ○ Draft talk outline ▣ Talk  2/4  15:00  │ Subtasks   2/4 ▓▓░│
│  │   Website  ▓▓▓░ 50%│ Scheduled                             1  │ Linked notes      │
│  │   Kitchen  ▓░░░ 33%│ Daily note — 2026-11-02          Open →  │ Reminder          │
│  │ NOTES           ▾  │   Focus: finish the talk outline…        │                   │
│⚙ │   ▸ Projects …     │ Events  · connect a calendar in Settings │ Delete            │
├──┴────────────────────┴──────────────────────────────────────────┴───────────────────┤
│ ● Synced · 14:32    ☁ Calendar: not connected            Ctrl K  ?  Shortcuts        │
└──────────────────────────────────────────────────────────────────────────────────────┘
 rail 48 │ sidebar 260 (Ctrl+B)   │ main, max 920 for lists / 72ch for notes │ panel 400 (docked ≥1280)
```

- The rail has Home (Today), Tasks, Projects, Notes and Search, with Settings at the bottom. Rail and
  sidebar render the sidebar sections from one config (`NAV_SECTIONS`), and the palette's "Go to…" reads
  the same list.
- **Removed from top-level nav:** Day (it becomes Week's "today" column, or a Today-page date picker; see
  Q2), Board (a view toggle on All tasks and project pages), Calendar, Sync and Notifications (Settings
  sections plus the status bar), and Search (the rail icon opens the palette; `/search` stays as the
  "see all results" page).
- The topbar is removed. User and Sign out move to the Settings page and an account item in the rail's
  bottom menu.
- At 1024–1279 px the sidebar starts collapsed when a note is open, and the detail panel overlays.

### 4.2 Mobile (< 720 px)

```
┌────────────────────────────┐   ┌────────────────────────────┐
│ ☰  Today         ⌕   ⋯     │   │ ←  Draft talk outline  ✓   │  full-screen sheet
├────────────────────────────┤   ├────────────────────────────┤
│ Overdue                 4  │   │ ○ In progress   ⚑ High     │
│ ○ Renew passport   Fri 30  │   │ 📅 Today 15:00   ↻ Never   │
│ ○ Send invoice     Sun 1   │   │ ▣ Conference talk          │
│ Due today               2  │   │ # writing                  │
│ ○ Draft talk outline 15:00 │   │ Description…               │
│ ○ Pick up dry cleaning     │   │ Subtasks 2/4               │
│ Daily note           Open→ │   │ …                          │
│                        (+) │   │                            │
├────────────────────────────┤   └────────────────────────────┘
│ ☀Today ▢Inbox ▣Proj ▤Notes ⚙│  bottom nav (5), ≥44px targets; ☰ opens the sidebar as a drawer
└────────────────────────────┘
```

The floating `+` button opens quick capture. Row actions open the shared menu from §3.4. The notes tree is
a drawer, so the editor is visible first.

### 4.3 Per-page recommendations

- **Today (home).** A greeting-free header with the date. Capture is the only primary action. Sections are
  collapsible and counted: Overdue (in warning colour), Due today, Scheduled, Daily note and Events. The
  daily note preview renders the first 3 lines through `MarkdownPreview`, not a flattened excerpt. The
  Events slot is one muted line, not a section of placeholder prose.
- **Inbox.** One row per item: checkbox, title and meta. Triage moves to hover or focus icons and
  keyboard: `t` today, `m` tomorrow, `d` date menu, `p` project picker, `Backspace` delete with undo. This
  keeps J2's "≤ 2 interactions" while removing six persistent controls per row. Show "Inbox zero" as an
  empty state.
- **Tasks (All tasks).** Replace the stacked form with a single **filter bar**: search field plus chips
  (`Status: Open ▾`, `Priority ▾`, `Project ▾`, `Due ▾`, `Sort ▾`). Each chip opens a popover, and the
  URL state is unchanged (ADR-0045). Saved filters move to the sidebar under *Saved filters*, and "Save
  view" goes in the filter bar's "…" menu. Bulk selection appears on checkbox hover or `x`, with a
  floating bulk bar. Add a Board/List segmented toggle; this is where Board lives.
- **Projects and Board.**
  - The list becomes cards or rows with name, inline progress bar (tokenised, not `<progress>` default
    colour), target date, open count and a "…" menu. Archive moves into that menu, not a visible button
    per row.
  - The project page has a header (name, status pill, progress, dates, "…"), then tabs **Tasks | Board |
    Notes**. Completed tasks fold into a "Completed (3)" group.
  - On the board, cards are compact (title, flag, due, project dot) and the per-card `<select>` becomes a
    "Move to…" item in the card menu plus keyboard shortcuts `[`/`]`, which keeps the accessible
    alternative to drag. Archived is hidden behind a toggle.
- **Notes.**
  - The sidebar *is* the tree; there is no second panel. The header has New note, New folder and Collapse
    all icons, and rows have hover "…" (Rename, Move, Delete, New from template).
  - Editor header: breadcrumb path, then on the right a saved state ("Saved" / "Unsaved ●"), the
    Source/Live/Split toggle and a "…" menu (Task from selection, Rename, Delete, Open in folder path).
    Auto-save with a debounce is **not** proposed here, because it affects the conflict flow (Q4). Ctrl+S
    stays.
  - The editor fills the main height (no `60vh` cap) with a 72 ch centred measure, the `md` type step and
    a CodeMirror theme from tokens, so the gutter follows dark mode. Line numbers are off by default in
    Live mode.
  - **Live preview** (D-2: CodeMirror decorations) hides Markdown marks on non-cursor lines, renders
    headings at scale, and makes `[[links]]` clickable. It is a view mode only, and the file is unchanged.
    Until it lands, render `[[links]]` as links in the preview.
  - Links, Backlinks, linked tasks and projects go into a **right panel** (toggle Ctrl+Alt+B). The revision
    number and `.md` paths are hidden behind a hover tooltip.
- **Task detail.**
  - The title is an inline-edit `lg` heading. Below it, a **property list** (Notion style) of 28 px rows
    with icon, label and value: Status, Priority, Due, Start, Repeat, Project, Tags and Reminder. Each
    opens a popover.
  - Time zone becomes a searchable select, shown only when it differs from the viewer's zone.
  - Description is an auto-growing textarea, followed by Subtasks, Linked notes and Activity.
  - Changes save per field with optimistic updates through the existing `base_revision` path, or keep one
    sticky *Save* bar if per-field saving is not wanted (Q4).
  - Delete goes into the "…" menu. The panel docks on wide screens so the list stays visible.
- **Settings.** A two-column layout: a section list on the left (Account, Appearance, Notifications and
  reminders, Calendar, Sync, Data and backups, About) and one section at a time on the right. This
  absorbs the Sync, Calendar and Notifications pages. Rows use the "label + description left, control
  right" pattern, and each section has one primary button at most.
- **Command palette.** Keep the grouping. Add icons per group, a `>` command mode, recent items on an
  empty query, right-aligned shortcut hints, and `--accent-soft` for the active row instead of solid
  accent. It stays the only global search entry.

## 5. Accessibility and responsive findings

**Observed:**

- **axe-core WCAG 2 A/AA** (10 routes × 2 themes): no violations except on `/notes`:
  - `aria-input-field-name` (serious): `.cm-content` has no accessible name; give the editor
    `aria-label="Note content"` via `EditorView.contentAttributes`.
  - `label` (critical) ×2: the task-list checkboxes rendered in the preview have no label.
- **Contrast:**
  - White on the old accent `#3b6ef5` was 4.44 : 1 (fails AA for 14–15 px text: sidebar active item,
    primary buttons). MU-08 has since changed it to `#2c5ce0`, which passes.
  - Disabled buttons at 60 % opacity fall well below 3 : 1 (`Add`, `Save`, `This week`).
  - `--border` against the background is 1.28 : 1 (light) and 1.23 : 1 (dark). That is fine for dividers,
    but it is also the only outline on inputs and checkboxes, so control boundaries fail WCAG 1.4.11's
    3 : 1. Section 3.1 adds `--border-control`.
- **Dark mode before login** is not applied (`login_desktop_dark.png`, `setup_*_dark.png`). There is also
  a light flash on load for dark-theme users.
- **Focus:** a visible ring exists for `input`, `button`, `a` and `select`. The task detail does not dim
  the page or appear to trap focus; this needs a keyboard check (not verified). Clicking a title opens a
  sheet that hides the clicked row at 1024–1440 px.
- **Responsive:**
  - No horizontal page overflow at any captured size (`scrollWidth == clientWidth` on all 120 page shots).
  - Mobile Inbox is 2,746 px for 9 items, and mobile Notes puts the editor below 1,100 px.
  - In `notes-open_mobile_dark.png`, CodeMirror line numbers are visibly out of step with the wrapped
    lines. This is likely a gutter measured before final layout; the cause is not verified.
  - Week at 1024 px gives 7 cramped columns, each about 150 px (`week_laptop_*`).
  - Board at 390 px stacks 5 columns, 2,346 px tall.
- **Semantics that are already good:** label/`htmlFor` on forms, `role="alert"` for errors, named
  `aria-label`s on row buttons ("Open …", "Complete …"), the palette's listbox pattern, and `sr-only`
  labels. Keep these when restyling.

**Not verified:** screen-reader output, focus order inside the sheet and palette, high-contrast or forced
colours, real iOS/Android browsers (only Chromium emulation), 200 % zoom, and reduced motion.

## 6. Prioritised implementation plan

Each task is a vertical, independently shippable slice. They should run **after MU-08 lands** and in this
order, because every page task depends on UX-01 and UX-02. None adds a data store or a backend change.
Each task's verification includes: `npm run lint`, `npm run typecheck`, `npm test`, `npm run
test:e2e:real` (J1–J7 must still pass, with selectors kept or updated only where the visible label
legitimately changed), an axe run with zero violations on touched routes, and a screenshot set at
1440/1024/390 × light/dark compared side by side with this audit's set.

| ID | Title | Scope | Acceptance | Size | Type | Risk |
|---|---|---|---|---|---|---|
| **UX-01** | Design tokens and base controls | Replace `:root` with §3.1–3.2 tokens. CSS dark mode via `prefers-color-scheme` plus `data-theme`, a pre-paint theme script in `index.html`, and a System/Light/Dark setting. Base rules for button variants, input, textarea, select, checkbox, `.pill`, kbd and section header. Delete the four duplicate badge classes and three duplicate heading rules. Tokenise the CodeMirror theme. | Only scale values appear in `font-size`/`gap`/`padding`, enforced by a grep check in CI. Login and setup follow the OS dark theme. No light flash. The editor gutter is dark in dark mode. Contrast table §3.1 is met (a unit test reads tokens and checks the ratios). | M | Pure CSS/markup, plus a small TS change in `theme.ts` and `NoteEditor` theme | Low; visual-only, but touches every page, so review the screenshot diff |
| **UX-02** | App shell: rail, sectioned sidebar, status bar, mobile bottom nav | `Layout.tsx`: rail with 5 destinations plus Settings, collapsible sections from one `NAV_SECTIONS` config (the palette reads it), sidebar collapse (Ctrl+B, remembered per browser), status bar from `useSyncStatus`/offline queue, mobile bottom nav and drawer. Remove the topbar. Routes stay, except Day/Calendar/Sync/Notifications, which redirect to their new homes. Vendored `Icon.tsx` (§3.3). | No more than 6 top-level destinations. The active state is unique. The status bar shows offline, queued and conflict states (component test with a mocked queue). All old URLs still resolve. J1–J7 pass. Mobile shows the bottom nav and no horizontal nav strip. | L | Markup/CSS/TS; vendored icons (ISC notice), **no npm dependency** | Medium: IA change. Old bookmarks must redirect. e2e selectors for nav links may need updating. |
| **UX-03** | Task row, menus and quick actions | One `TaskRow`: round checkbox, title, meta (project dot, due with overdue colour, priority flag, subtask count), hover/focus actions and a "…" menu. A shared `Menu`/`Popover` (date shortcuts, project picker, priority). Apply it to Today, Inbox, Upcoming, Week, project lists and search. List keyboard nav (`j`/`k`/`x`/`t`/`m`/`p`/Enter). | Inbox has ≤ 2 persistent controls per row; J2 still passes with ≤ 2 interactions per item. Each row is ≤ 40 px on desktop. All actions work keyboard-only (Playwright). Mobile Inbox with 9 items is under 1,000 px. | M | Pure markup/CSS/TS | Medium: popover focus management. Reuse native `<dialog>`/`popover` where possible. |
| **UX-04** | Task detail as a property panel | Inline title, property rows with popovers, a searchable time-zone select, auto-growing description. The panel docks at ≥ 1280 px, overlays with a scrim below that, and is a full-screen sheet on mobile. Focus trap and return. Save model per Q4. | J1 passes, including the stale-edit conflict. Escape closes it and focus returns to the row. *Save* or the state indicator is visible without scrolling at 900 px height. The list stays visible when docked. | M | Pure markup/CSS/TS | Medium: per-field save changes request volume and the conflict UX, so it needs Q4 |
| **UX-05** | Notes workspace | The sidebar tree becomes the notes navigator (chevrons, hover actions, header icons). The editor takes the full height with a 72 ch measure, a header with breadcrumb, saved state and mode toggle, and a right panel for links/backlinks/tasks/projects. `[[links]]` are clickable in the preview. Accessible name on `.cm-content`. The mobile tree becomes a drawer. | At 1024 px with the panel closed, the editor shows ≥ 60 ch per line. axe `/notes` is clean. J4 and J6 pass. Mobile shows the editor within the first screen. Notes on disk are byte-identical before and after an open/close (no format change, AGENTS.md §8). | M | Pure markup/CSS/TS (CodeMirror already a dependency) | Low–medium |
| **UX-06** | Live preview mode (D-2) | CodeMirror decorations: hide marks on non-active lines, scaled headings, rendered checkboxes, clickable `[[links]]`, inline code styling. Toggle Source/Live/Split, remembered per browser. Plus `/` slash menu inserting plain Markdown. | Round-trip test: typing in Live mode yields the same file text as typing in Source. Wiki-link click opens the note. Undo history works across mode switches. | L | TS; **no new dependency** (`@codemirror/view` decorations) | Medium: CodeMirror edge cases (tables, nested lists). Ship behind the mode toggle, with Source as default until it is verified. |
| **UX-07** | Tasks, Projects and Board polish | Filter-chip bar (URL state unchanged, ADR-0045). Saved filters in the sidebar. Board as a view toggle, with compact cards, a card menu "Move to…", Archived hidden by default and `[`/`]` keys. Project header with tabs and a Completed group. Tokenised progress bar. Unified date format (one `formatDate` helper). | `tasks-page.spec` and J3 pass. The Tasks filter UI is one row at 1440 px. Board at 1440 px with the seeded data is ≤ 1,200 px tall. No ISO dates are shown to users. | M | Pure markup/CSS/TS | Low |
| **UX-08** | Settings consolidation and states | Settings with a section list absorbing Sync, Calendar and Notifications. Skeletons and empty states from §3.4 on every page. Compact-density toggle. | J7 passes. No page shows "Loading…" text without a skeleton. Every empty list has an icon, a sentence and an action. | S–M | Pure markup/CSS/TS | Low; overlaps MU-08, so build on its Settings page and do not redo it |

**Quick wins (< 1 day each; can be bundled into UX-01 or done right after MU-08):**

1. Add CSS-level `prefers-color-scheme` and a pre-paint theme script, so login and setup are dark and the
   light flash goes away.
2. Add a CodeMirror theme from tokens (dark gutter) and `aria-label` on `.cm-content`.
3. Make the default `button` secondary, add an explicit `.primary`, and use primary only for the main CTA.
   Week/Day navigation becomes ghost buttons.
4. Replace the "Complete" button with a round checkbox in `TaskList.tsx`, keeping
   `aria-label="Complete …"`.
5. Give priority pills colour and sentence case ("High" in warning, "Urgent" in danger). Show tags as
   muted `#tag` text.
6. Add a base `textarea` rule; exclude checkboxes and radios from the `input` padding rule; style
   `progress` with the accent.
7. Remove `max-height: 60vh` from `.editor-host` and `.markdown-preview`; cap prose width at 72 ch.
8. Section headings: sentence case, 12 px, `--text-3`, with the count on the right.
9. Render the daily note excerpt through `MarkdownPreview` (3 lines) instead of flattened text.
10. Hide "revision N" in the notes toolbar; show "Saved" / "Unsaved" instead.

## 7. Open questions for the owner

1. **Accent colour.** Indigo `#4f46e5` / `#818cf8` (proposed), keep blue, or a neutral-only look like
   Notion? *Default: indigo.*
2. **Day view.** Remove `/day` as a nav item (it duplicates Today; Week's columns cover other days), or
   keep it? *Default: remove from nav and keep the route redirecting to Today with a date picker.*
3. **Icons.** Vendor about 25 Lucide SVGs (ISC, no dependency) or add `lucide-react`? *Default: vendor.*
4. **Save model in task detail and notes.** Keep explicit Save (current, simplest conflict story), or
   save each field or note change automatically? *Default: auto-save task properties per field (each is
   one PATCH with `base_revision`); keep explicit Ctrl+S for notes until conflict handling for debounced
   saves is designed.*
5. **Default editor mode once live preview exists.** *Default: Source until UX-06 passes its round-trip
   tests, then Live, with the last choice remembered per browser.*
