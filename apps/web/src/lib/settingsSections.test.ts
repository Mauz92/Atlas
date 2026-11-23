import {
  DEFAULT_SETTINGS_SECTION,
  parseSettingsSection,
  SETTINGS_REDIRECTS,
  SETTINGS_SECTIONS,
  settingsPath,
} from "./settingsSections";

describe("settings sections", () => {
  it("lists the nine sections in the approved order", () => {
    expect(SETTINGS_SECTIONS.map((section) => section.label)).toEqual([
      "Account",
      "Appearance",
      "Notifications and reminders",
      "Calendar",
      "Sync",
      "Devices",
      "Data and backups",
      "Plugins",
      "About",
    ]);
    expect(new Set(SETTINGS_SECTIONS.map((section) => section.id)).size).toBe(SETTINGS_SECTIONS.length);
  });

  it("parses a URL segment and rejects anything else", () => {
    expect(parseSettingsSection("sync")).toBe("sync");
    expect(parseSettingsSection("Sync")).toBeNull();
    expect(parseSettingsSection("")).toBeNull();
    expect(parseSettingsSection(undefined)).toBeNull();
    expect(parseSettingsSection("../etc")).toBeNull();
    expect(parseSettingsSection(DEFAULT_SETTINGS_SECTION)).toBe("account");
  });

  it("sends each page that moved into Settings to a real section", () => {
    for (const target of Object.values(SETTINGS_REDIRECTS)) {
      const id = target.replace("/settings/", "");
      expect(parseSettingsSection(id)).not.toBeNull();
      expect(settingsPath(parseSettingsSection(id)!)).toBe(target);
    }
    expect(Object.keys(SETTINGS_REDIRECTS).sort()).toEqual(["/notifications", "/sync"]);
  });
});
