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
    description: "Who you are signed in as, your display name and your password.",
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
    palette: "Calendar",
    description:
      "Sync status for your connected calendars. Calendar views (day, week and month) are coming in a later milestone.",
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
    description: "Take your notes, tasks and projects with you, and see whether backups are running.",
  },
  {
    id: "about",
    label: "About",
    palette: "About Atlas",
    description: "Version and health of this Atlas instance.",
  },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

/** The section a plain `/settings` shows on a wide screen. */
export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = "account";

export function settingsPath(id: SettingsSectionId): string {
  return `/settings/${id}`;
}

/** The section named by a URL segment, or `null` when it is missing or unknown. */
export function parseSettingsSection(segment: string | undefined): SettingsSectionId | null {
  return SETTINGS_SECTIONS.find((section) => section.id === segment)?.id ?? null;
}

/** Pages that moved into Settings (UX-08), mapped to the section that now holds them. */
export const SETTINGS_REDIRECTS: Record<string, string> = {
  "/sync": settingsPath("sync"),
  "/notifications": settingsPath("notifications"),
  "/calendar": settingsPath("calendar"),
};

/** What the command palette offers for Settings: "Go to <label>" for every section. */
export const SETTINGS_PALETTE: { to: string; label: string }[] = SETTINGS_SECTIONS.map((section) => ({
  to: settingsPath(section.id),
  label: section.palette,
}));
