import { NotificationConsent } from "../components/NotificationConsent";
import { ReminderPreferences } from "../components/ReminderPreferences";
import { useReminderPreferences } from "../hooks/useReminderPreferences";
import { useWebPush } from "../hooks/useWebPush";

/**
 * The Notifications route (M8-02 consent + M8-05 preferences).
 *
 * Two surfaces: an explicit permission/consent gate for desktop notifications (M8-02), and the
 * reminder-timing preferences (M8-05) that decide *when* a reminder fires. The state and behaviour
 * live in `useWebPush`/`useReminderPreferences` and their `lib` modules, so this page only wires them
 * to the presentational components.
 */
export function NotificationsPage() {
  const consent = useWebPush();
  const reminder = useReminderPreferences();

  return (
    <section className="page notifications-page">
      <h1>Notifications</h1>
      <p className="muted">
        Get a desktop notification when a reminder is due — even when Atlas is closed. Deliveries go
        through your browser's push service; nothing is sent while notifications are off.
      </p>
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
    </section>
  );
}
