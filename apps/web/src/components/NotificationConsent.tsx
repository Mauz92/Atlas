import type { PushUiState } from "../lib/webpush";

interface NotificationConsentProps {
  /** The derived Web Push state (see `derivePushUiState`). */
  state: PushUiState;
  /** True while the server configuration and the browser state are still being read. */
  loading?: boolean;
  /** A failure from loading, subscribing or unsubscribing. */
  error?: string | null;
  /** True while a subscribe/unsubscribe action is in flight. */
  busy?: boolean;
  onEnable: () => void;
  onDisable: () => void;
}

const COPY: Record<PushUiState, { badge: string; title: string; description: string }> = {
  unsupported: {
    badge: "Unsupported",
    title: "This browser can't show notifications",
    description:
      "Web Push is not available here. Try a current version of Chrome, Edge, Firefox or Safari over a secure connection.",
  },
  disabled: {
    badge: "Unavailable",
    title: "Notifications aren't available on this server",
    description:
      "This Atlas server has not been configured to send Web Push. Ask the operator to set the VAPID keys.",
  },
  denied: {
    badge: "Blocked",
    title: "Notifications are blocked",
    description:
      "You turned notifications off for Atlas in this browser. Re-enable them in your browser's site settings to receive reminders.",
  },
  prompt: {
    badge: "Off",
    title: "Turn on desktop notifications",
    description:
      "Allow Atlas to notify you when a reminder is due — even when this tab is closed.",
  },
  granted: {
    badge: "Allowed",
    title: "Finish enabling notifications",
    description:
      "Notifications are allowed. Register this device so reminders can be delivered to it.",
  },
  subscribed: {
    badge: "On",
    title: "Notifications are on",
    description: "This device will receive a notification when a reminder is due.",
  },
};

/**
 * The Web Push permission/consent surface (M8-02).
 *
 * Presentational: it renders the state passed in and calls back to the hook (business logic stays in
 * `lib`/`hooks`, AGENTS.md §6). Every state is explicit — unsupported, server-disabled, blocked,
 * not-yet-asked, allowed-but-unregistered and subscribed — and the single action button is a real
 * `<button>` (keyboard-focusable), disabled while an action is in flight. Styling uses the shared
 * theme variables, so light and dark both work.
 */
export function NotificationConsent({
  state,
  loading = false,
  error = null,
  busy = false,
  onEnable,
  onDisable,
}: NotificationConsentProps) {
  if (loading) {
    return (
      <p className="muted" role="status">
        Checking notification support…
      </p>
    );
  }

  const copy = COPY[state];
  const canEnable = state === "prompt" || state === "granted";

  return (
    <div className="notification-consent">
      <div className="notification-consent-head">
        <span className={`notification-badge notification-badge-${state}`}>{copy.badge}</span>
        <h2>{copy.title}</h2>
      </div>
      <p className="muted">{copy.description}</p>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {canEnable || state === "subscribed" ? (
        <div className="notification-consent-actions">
          {canEnable ? (
            <button type="button" onClick={onEnable} disabled={busy}>
              {busy ? "Enabling…" : "Enable notifications"}
            </button>
          ) : null}
          {state === "subscribed" ? (
            <button type="button" className="ghost" onClick={onDisable} disabled={busy}>
              {busy ? "Turning off…" : "Turn off notifications"}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
