import { useHomeTimeZone } from "../hooks/useHomeTimeZone";
import { useReminderPreferences } from "../hooks/useReminderPreferences";
import { useWebPush } from "../hooks/useWebPush";
import { HomeTimeZone } from "./HomeTimeZone";
import { NotificationConsent } from "./NotificationConsent";
import { ReminderPreferences } from "./ReminderPreferences";

/**
 * Notification permission (M8-02), default reminder timing (M8-05) and the home time zone
 * (M8-04a) wired to their hooks. Shared
 * by the Notifications route and the Settings page so there is one wiring, not two.
 */
export function NotificationSettings() {
  const consent = useWebPush();
  const reminder = useReminderPreferences();
  const homeZone = useHomeTimeZone();

  return (
    <>
      <NotificationConsent
        state={consent.state}
        loading={consent.loading}
        error={consent.error}
        busy={consent.busy}
        onEnable={() => void consent.enable()}
        onDisable={() => void consent.disable()}
      />
      <ReminderPreferences
        timing={reminder.timing}
        loading={reminder.loading}
        saving={reminder.saving}
        error={reminder.error}
        saved={reminder.saved}
        onSave={(timing) => void reminder.save(timing)}
      />
      <HomeTimeZone
        zone={homeZone.zone}
        loading={homeZone.loading}
        saving={homeZone.saving}
        saved={homeZone.saved}
        error={homeZone.error}
        onSave={(zone) => void homeZone.save(zone)}
      />
    </>
  );
}
