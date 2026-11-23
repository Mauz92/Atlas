import { Link, Navigate, useParams } from "react-router-dom";

import { AboutSection } from "../components/settings/AboutSection";
import { AccountSection } from "../components/settings/AccountSection";
import { AppearanceSection } from "../components/settings/AppearanceSection";
import { DataSection } from "../components/settings/DataSection";
import { PluginsSection } from "../components/settings/PluginsSection";
import { DevicesSection } from "../components/settings/DevicesSection";
import { CalendarSettings } from "../components/CalendarSettings";
import { Icon } from "../components/Icon";
import { NotificationSettings } from "../components/NotificationSettings";
import { ShellSyncSettings } from "../components/ShellSyncSettings";
import { SyncSettings } from "../components/SyncSettings";
import { DesktopSection } from "../components/settings/DesktopSection";
import { isAndroidShell, isDesktopShell } from "../lib/desktop";
import {
  DEFAULT_DESKTOP_SETTINGS_SECTION,
  DEFAULT_SETTINGS_SECTION,
  parseSettingsSection,
  settingsPath,
  visibleSettingsSections,
  type SettingsSectionId,
} from "../lib/settingsSections";

function SectionBody({ id }: { id: SettingsSectionId }) {
  switch (id) {
    case "account":
      return <AccountSection />;
    case "appearance":
      return <AppearanceSection />;
    case "notifications":
      return <NotificationSettings />;
    case "calendar":
      return <CalendarSettings />;
    case "sync":
      if (isDesktopShell()) return <ShellSyncSettings />; // the engine's state; the browser's offline queue is never started in the shell
      return (
        <>
          <SyncSettings />
          <p className="settings-sync-link">
            <Link to="/changes">Changes from other devices</Link>
            <span className="muted">
              {" "}
              - what Atlas decided when two devices changed the same thing, with
              Undo.
            </span>
          </p>
        </>
      );
    case "devices":
      return <DevicesSection />;
    case "data":
      return <DataSection />;
    case "plugins":
      return <PluginsSection />;
    case "about":
      return <AboutSection />;
    case "desktop":
      return <DesktopSection />;
  }
}

/**
 * Settings (MU-08 content, UX-08 layout, ADR-0058): a list of sections on the left and one section
 * at a time on the right, addressed as `/settings/<section>`. A plain `/settings` shows Account on a
 * wide screen and only the list on a phone, where a section is a drill-in with an "All settings"
 * link back (a CSS switch on `data-view`, so no viewport logic lives here). Every section reuses
 * the component that already held its behaviour; this file only chooses which one to show.
 */
export function Settings() {
  const { section } = useParams();
  const shell = isDesktopShell();
  const sections = visibleSettingsSections(shell, isAndroidShell());
  const requested = parseSettingsSection(section, shell);
  if (section && !requested) {
    return <Navigate to="/settings" replace />;
  }
  const active =
    requested ??
    (shell ? DEFAULT_DESKTOP_SETTINGS_SECTION : DEFAULT_SETTINGS_SECTION);
  const current = sections.find((entry) => entry.id === active)!;

  return (
    <section
      className="page settings-page"
      data-view={requested ? "section" : "index"}
    >
      <h1>Settings</h1>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          <ul>
            {sections.map((entry) => (
              <li key={entry.id}>
                <Link
                  to={settingsPath(entry.id)}
                  className={`settings-nav-link${entry.id === active ? " active" : ""}`}
                  aria-current={
                    entry.id === active && requested ? "page" : undefined
                  }
                >
                  {entry.label}
                  <Icon
                    name="chevron-right"
                    size={14}
                    className="settings-nav-chevron"
                  />
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="settings-pane">
          <Link to="/settings" className="settings-back">
            <Icon name="chevron-left" size={14} />
            All settings
          </Link>
          <h2 id="settings-section-title">{current.label}</h2>
          <p className="muted settings-blurb">{current.description}</p>
          <div className="settings-body">
            <SectionBody key={active} id={active} />
          </div>
        </div>
      </div>
    </section>
  );
}
