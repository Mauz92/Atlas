import { Link, Navigate, useParams } from "react-router-dom";

import { AboutSection } from "../components/settings/AboutSection";
import { AccountSection } from "../components/settings/AccountSection";
import { AppearanceSection } from "../components/settings/AppearanceSection";
import { DataSection } from "../components/settings/DataSection";
import { DevicesSection } from "../components/settings/DevicesSection";
import { CalendarSettings } from "../components/CalendarSettings";
import { Icon } from "../components/Icon";
import { NotificationSettings } from "../components/NotificationSettings";
import { SyncSettings } from "../components/SyncSettings";
import {
  DEFAULT_SETTINGS_SECTION,
  parseSettingsSection,
  SETTINGS_SECTIONS,
  settingsPath,
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
      return <SyncSettings />;
    case "devices":
      return <DevicesSection />;
    case "data":
      return <DataSection />;
    case "about":
      return <AboutSection />;
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
  const requested = parseSettingsSection(section);
  if (section && !requested) {
    return <Navigate to="/settings" replace />;
  }
  const active = requested ?? DEFAULT_SETTINGS_SECTION;
  const current = SETTINGS_SECTIONS.find((entry) => entry.id === active)!;

  return (
    <section className="page settings-page" data-view={requested ? "section" : "index"}>
      <h1>Settings</h1>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          <ul>
            {SETTINGS_SECTIONS.map((entry) => (
              <li key={entry.id}>
                <Link
                  to={settingsPath(entry.id)}
                  className={`settings-nav-link${entry.id === active ? " active" : ""}`}
                  aria-current={entry.id === active && requested ? "page" : undefined}
                >
                  {entry.label}
                  <Icon name="chevron-right" size={14} className="settings-nav-chevron" />
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
