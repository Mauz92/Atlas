/**
 * The Settings sections, in one place (UX-08, ADR-0058, docs/UX_AUDIT.md §4.3).
 *
 * Settings shows one section at a time and the section is part of the URL (`/settings/<id>`), so a
 * link, a reload and the browser's Back button keep it. The former `/sync`, `/notifications` and
 * `/calendar` pages are sections now; `SETTINGS_REDIRECTS` keeps their old URLs working and the
 * command palette offers every section as "Go to …" (`SETTINGS_PALETTE`).
 */

export const SETTINGS_SECTIONS = [
  {
    id: "account",
    label: "Account",
    palette: "Account",
    description:
      "Who you are signed in as, your display name and your password.",
  },
  {
    id: "appearance",
    label: "Appearance",
    palette: "Appearance",
    description: "How Atlas looks on this device.",
  },
  {
    id: "notifications",
    label: "Notifications and reminders",
    palette: "Notifications",
    description:
      "Get a desktop notification when a reminder is due, even when Atlas is closed. Deliveries go through your browser's push service; nothing is sent while notifications are off.",
  },
  {
    id: "calendar",
    label: "Calendar",
    palette: "Calendar accounts",
    description:
      "Connect Google, Outlook or a calendar feed (for example from ProtonMail), choose which calendars to show and see whether they are syncing. Atlas only reads your calendars.",
  },
  {
    id: "sync",
    label: "Sync",
    palette: "Sync",
    description:
      "Changes you make offline are stored on this device and sent automatically when the connection returns. If an item changed on the server in the meantime, your edit is kept so you can decide what to do.",
  },
  {
    id: "devices",
    label: "Devices",
    palette: "Devices",
    description:
      "The desktop and phone apps that sync with this server. Sign one out here and it stops syncing at once.",
  },
  {
    id: "data",
    label: "Data and backups",
    palette: "Data and backups",
    description:
      "Take your notes, tasks and projects with you, and see whether backups are running.",
  },
  {
    id: "plugins",
    label: "Plugins",
    palette: "Plugins",
    description:
      "Optional modules that are bundled with Atlas and off by default. Turning one off hides it and keeps everything you created, ready for when you turn it back on.",
  },
  {
    id: "about",
    label: "About",
    palette: "About Atlas",
    description: "Version and health of this Atlas instance.",
  },
] as const;

/**
 * The extra section of the desktop app (SYNC-09d): per-device reminders, tray, autostart, notes folder.
 * It exists only inside the shell (`isDesktopShell()`); a browser never lists it or accepts its URL.
 */
export const DESKTOP_SECTION = {
  id: "desktop",
  label: "Desktop app",
  palette: "Desktop app",
  description:
    "This computer's Atlas app: its notes folder, reminders, tray and start-up behaviour. These settings belong to this device only.",
} as const;

/**
 * Sections a device token cannot use (SECURITY.md T22: account, password, calendar connections, device
 * management and the full export are browser-only). The desktop app hides them instead of showing
 * `403 forbidden_scope` errors; the browser stays the place for them.
 */
const BROWSER_ONLY_SECTIONS: ReadonlySet<string> = new Set([
  "account",
  "notifications",
  "calendar",
  "devices",
  "data",
  "plugins",
]);

export type SettingsSectionId =
  (typeof SETTINGS_SECTIONS)[number]["id"] | typeof DESKTOP_SECTION.id;

/** The sections to show: the browser's list, or inside the desktop app the usable ones plus "Desktop app". */
export const ANDROID_SECTION = {
  id: "desktop",
  label: "This app",
  palette: "This app",
  description:
    "This phone's Atlas app: its reminders and how they reach you, notes and sync status. These settings belong to this device only.",
} as const;

export function visibleSettingsSections(
  shell: boolean,
  android = false,
): readonly {
  id: SettingsSectionId;
  label: string;
  palette: string;
  description: string;
}[] {
  if (!shell) return SETTINGS_SECTIONS;
  return [
    android ? ANDROID_SECTION : DESKTOP_SECTION,
    ...SETTINGS_SECTIONS.filter(
      (section) => !BROWSER_ONLY_SECTIONS.has(section.id),
    ),
  ];
}

/** The section a plain `/settings` shows on a wide screen. */
export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = "account";
export const DEFAULT_DESKTOP_SETTINGS_SECTION: SettingsSectionId = "desktop";

export function settingsPath(id: SettingsSectionId): string {
  return `/settings/${id}`;
}

/** The section named by a URL segment, or `null` when it is missing or unknown. */
export function parseSettingsSection(
  segment: string | undefined,
  shell = false,
): SettingsSectionId | null {
  return (
    visibleSettingsSections(shell).find((section) => section.id === segment)
      ?.id ?? null
  );
}

/** Pages that moved into Settings (UX-08), mapped to the section that now holds them. */
export const SETTINGS_REDIRECTS: Record<string, string> = {
  "/sync": settingsPath("sync"),
  "/notifications": settingsPath("notifications"),
};

/** What the command palette offers for Settings: "Go to <label>" for every section. */
export const SETTINGS_PALETTE: { to: string; label: string }[] =
  SETTINGS_SECTIONS.map((section) => ({
    to: settingsPath(section.id),
    label: section.palette,
  }));
