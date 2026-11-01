import { useCallback, useEffect, useState } from "react";

import {
  notificationsApi,
  type WebPushConfig,
  type WebPushSubscriptionRegistration,
} from "../api/client";
import {
  createBrowserWebPushClient,
  derivePushUiState,
  type PushUiState,
  type WebPushClient,
} from "../lib/webpush";

/** The slice of the notifications API the hook needs (kept narrow so it can be faked in tests). */
export interface NotificationsApi {
  config: () => Promise<WebPushConfig>;
  registerDevice: (registration: WebPushSubscriptionRegistration) => Promise<unknown>;
  unregisterDevice: (endpoint: string) => Promise<void>;
}

export interface WebPushResult {
  /** The single UI state the consent surface renders (see `PushUiState`). */
  state: PushUiState;
  /** True until the server config and any existing subscription have been read. */
  loading: boolean;
  error: string | null;
  /** True while a subscribe/unsubscribe action is in flight. */
  busy: boolean;
  /** Request permission, subscribe with the VAPID key and register the destination. */
  enable: () => Promise<void>;
  /** Unregister the destination and drop the browser subscription. */
  disable: () => Promise<void>;
}

/**
 * Orchestrate the Web Push consent flow (M8-02).
 *
 * The *decisions* live in `lib/webpush.ts`; this hook only reads the server configuration and the
 * browser's current state, runs the enable/disable steps against the API and the `WebPushClient`, and
 * exposes the derived UI state. It takes the client and API as arguments so it can be tested over
 * fakes, defaulting to the real browser client and the app's API client.
 */
export function useWebPush(
  client: WebPushClient = createBrowserWebPushClient(),
  api: NotificationsApi = notificationsApi,
): WebPushResult {
  const [config, setConfig] = useState<WebPushConfig | null>(null);
  const [permission, setPermission] = useState<NotificationPermission>(() => client.permission());
  const [subscribed, setSubscribed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [supported] = useState(() => client.isSupported());

  const load = useCallback(async () => {
    try {
      const cfg = await api.config();
      setConfig(cfg);
      if (cfg.enabled && supported) {
        try {
          setSubscribed((await client.currentSubscription()) !== null);
        } catch {
          setSubscribed(false);
        }
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load notification settings");
      setConfig(null);
    } finally {
      setLoading(false);
    }
  }, [api, client, supported]);

  useEffect(() => {
    void load();
  }, [load]);

  const enable = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await client.requestPermission();
      setPermission(result);
      if (result !== "granted") {
        setSubscribed(false);
        return;
      }
      const key = config?.vapid_public_key;
      if (!key) {
        setError("Web Push is not configured on this server.");
        return;
      }
      const subscription = await client.subscribe(key);
      await api.registerDevice({
        channel: "web",
        endpoint: subscription.endpoint,
        p256dh: subscription.p256dh,
        auth: subscription.auth,
        platform: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
      });
      setSubscribed(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not enable notifications");
    } finally {
      setBusy(false);
    }
  }, [api, client, config]);

  const disable = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const current = await client.currentSubscription();
      if (current) {
        await api.unregisterDevice(current.endpoint);
      }
      await client.unsubscribe();
      setSubscribed(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not turn off notifications");
    } finally {
      setBusy(false);
    }
  }, [api, client]);

  return {
    state: derivePushUiState({
      supported,
      serverEnabled: config?.enabled ?? false,
      permission,
      subscribed,
    }),
    loading,
    error,
    busy,
    enable,
    disable,
  };
}
