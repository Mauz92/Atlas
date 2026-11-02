import { useReminderPreferences } from "../hooks/useReminderPreferences";
import { useWebPush } from "../hooks/useWebPush";
import { NotificationConsent } from "./NotificationConsent";
import { ReminderPreferences } from "./ReminderPreferences";

/**
 * Notification permission (M8-02) and default reminder timing (M8-05) wired to their hooks. Shared
 * by the Notifications route and the Settings page so there is one wiring, not two.
 */
export function NotificationSettings() {
  const consent = useWebPush();
  const reminder = useReminderPreferences();

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
    </>
  );
}
