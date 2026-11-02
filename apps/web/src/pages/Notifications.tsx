import { NotificationSettings } from "../components/NotificationSettings";

/**
 * The Notifications route (M8-02 consent + M8-05 preferences). The same sections also appear on the
 * Settings page; the wiring lives in `NotificationSettings`.
 */
export function NotificationsPage() {
  return (
    <section className="page notifications-page">
      <h1>Notifications</h1>
      <p className="muted">
        Get a desktop notification when a reminder is due — even when Atlas is closed. Deliveries go
        through your browser's push service; nothing is sent while notifications are off.
      </p>
      <NotificationSettings />
    </section>
  );
}
