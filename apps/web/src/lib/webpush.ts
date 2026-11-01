/**
 * Web Push browser logic (M8-02).
 *
 * Everything that decides *what* the consent UI shows and *how* a subscription is formed lives here
 * (business logic out of components, AGENTS.md §6): the pure state rule, the base64url VAPID-key
 * decode, the subscription serialiser, and a thin bridge over the real browser APIs. The bridge is an
 * interface (`WebPushClient`) so the hook and its tests can run against a fake without a real push
 * service (AGENTS.md §13).
 */

/** The `{endpoint, p256dh, auth}` the API stores for a web destination. */
export interface PushSubscriptionPayload {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * The states the permission/consent UI distinguishes:
 * - `unsupported` — the browser cannot do Web Push at all;
 * - `disabled` — the server has no VAPID keys, so nothing could be delivered;
 * - `denied` — the user blocked notifications (nothing to offer but guidance);
 * - `prompt` — permission has not been decided yet;
 * - `granted` — permission granted, but this device is not subscribed yet;
 * - `subscribed` — permission granted and this device is registered for push.
 */
export type PushUiState =
  | "unsupported"
  | "disabled"
  | "denied"
  | "prompt"
  | "granted"
  | "subscribed";

export interface PushStateInput {
  supported: boolean;
  serverEnabled: boolean;
  permission: NotificationPermission;
  subscribed: boolean;
}

/**
 * Derive the single UI state from the four facts. Order matters: capability and server support are
 * prerequisites, a blocked permission can never deliver, and a live subscription outranks a bare
 * `granted` permission.
 */
export function derivePushUiState(input: PushStateInput): PushUiState {
  if (!input.supported) {
    return "unsupported";
  }
  if (!input.serverEnabled) {
    return "disabled";
  }
  if (input.permission === "denied") {
    return "denied";
  }
  if (input.subscribed) {
    return "subscribed";
  }
  return input.permission === "granted" ? "granted" : "prompt";
}

/** Decode a base64url VAPID public key into the bytes `PushManager.subscribe` expects. */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalised = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalised);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) {
    bytes[index] = raw.charCodeAt(index);
  }
  return bytes;
}

/** The registration fields for a browser subscription, or a clear error if it is incomplete. */
export function subscriptionToPayload(subscription: PushSubscription): PushSubscriptionPayload {
  const json = subscription.toJSON();
  const keys = json.keys ?? {};
  if (!json.endpoint || !keys.p256dh || !keys.auth) {
    throw new Error("The browser returned an incomplete push subscription.");
  }
  return { endpoint: json.endpoint, p256dh: keys.p256dh, auth: keys.auth };
}

/** The browser capabilities the hook needs; kept behind an interface so it can be faked in tests. */
export interface WebPushClient {
  isSupported(): boolean;
  permission(): NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  currentSubscription(): Promise<PushSubscriptionPayload | null>;
  subscribe(applicationServerKey: string): Promise<PushSubscriptionPayload>;
  unsubscribe(): Promise<void>;
}

/** The service worker that handles `push` events; served from the app root (see `public/sw.js`). */
export const SERVICE_WORKER_URL = "/sw.js";

/** A `WebPushClient` backed by the real `Notification`/`ServiceWorker`/`PushManager` APIs. */
export function createBrowserWebPushClient(): WebPushClient {
  const registration = async (): Promise<ServiceWorkerRegistration | undefined> => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
      return undefined;
    }
    return (await navigator.serviceWorker.getRegistration()) ?? undefined;
  };

  return {
    isSupported: () =>
      typeof window !== "undefined" &&
      "Notification" in window &&
      "serviceWorker" in navigator &&
      "PushManager" in window,
    permission: () => (typeof Notification !== "undefined" ? Notification.permission : "denied"),
    requestPermission: () => Notification.requestPermission(),
    async currentSubscription() {
      const existing = await registration();
      const subscription = await existing?.pushManager.getSubscription();
      return subscription ? subscriptionToPayload(subscription) : null;
    },
    async subscribe(applicationServerKey: string) {
      await navigator.serviceWorker.register(SERVICE_WORKER_URL);
      const ready = await navigator.serviceWorker.ready;
      const subscription = await ready.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(applicationServerKey),
      });
      return subscriptionToPayload(subscription);
    },
    async unsubscribe() {
      const existing = await registration();
      const subscription = await existing?.pushManager.getSubscription();
      await subscription?.unsubscribe();
    },
  };
}
