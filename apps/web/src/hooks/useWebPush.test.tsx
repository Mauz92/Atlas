import { act, renderHook, waitFor } from "@testing-library/react";

import type { WebPushSubscriptionRegistration } from "../api/client";
import type { PushSubscriptionPayload, WebPushClient } from "../lib/webpush";
import { useWebPush, type NotificationsApi } from "./useWebPush";

const SUB: PushSubscriptionPayload = {
  endpoint: "https://push.example/abc",
  p256dh: "BPUB",
  auth: "AUTH",
};

class FakeClient implements WebPushClient {
  supported = true;
  permissionValue: NotificationPermission = "default";
  requestResult: NotificationPermission = "granted";
  subscription: PushSubscriptionPayload | null = null;
  subscribeCalls: string[] = [];
  unsubscribeCalls = 0;

  isSupported(): boolean {
    return this.supported;
  }

  permission(): NotificationPermission {
    return this.permissionValue;
  }

  async requestPermission(): Promise<NotificationPermission> {
    this.permissionValue = this.requestResult;
    return this.requestResult;
  }

  async currentSubscription(): Promise<PushSubscriptionPayload | null> {
    return this.subscription;
  }

  async subscribe(key: string): Promise<PushSubscriptionPayload> {
    this.subscribeCalls.push(key);
    this.subscription = SUB;
    return SUB;
  }

  async unsubscribe(): Promise<void> {
    this.unsubscribeCalls += 1;
    this.subscription = null;
  }
}

function fakeApi(overrides: Partial<NotificationsApi> = {}): NotificationsApi & {
  registerDevice: ReturnType<typeof vi.fn>;
  unregisterDevice: ReturnType<typeof vi.fn>;
} {
  return {
    config: vi.fn(async () => ({ enabled: true, vapid_public_key: "BPUB" })),
    registerDevice: vi.fn(async () => ({})),
    unregisterDevice: vi.fn(async () => undefined),
    ...overrides,
  } as NotificationsApi & {
    registerDevice: ReturnType<typeof vi.fn>;
    unregisterDevice: ReturnType<typeof vi.fn>;
  };
}

describe("useWebPush", () => {
  it("reports a subscribed device when the server is enabled and a subscription exists", async () => {
    const client = new FakeClient();
    client.subscription = SUB;
    client.permissionValue = "granted";

    const { result } = renderHook(() => useWebPush(client, fakeApi()));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.state).toBe("subscribed");
  });

  it("reports the feature disabled when the server has no VAPID keys", async () => {
    const api = fakeApi({
      config: vi.fn(async () => ({ enabled: false, vapid_public_key: null })),
    });
    const { result } = renderHook(() => useWebPush(new FakeClient(), api));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.state).toBe("disabled");
  });

  it("reports unsupported when the browser cannot push", async () => {
    const client = new FakeClient();
    client.supported = false;
    const { result } = renderHook(() => useWebPush(client, fakeApi()));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.state).toBe("unsupported");
  });

  it("enables: asks permission, subscribes with the VAPID key and registers the destination", async () => {
    const client = new FakeClient();
    const api = fakeApi();
    const { result } = renderHook(() => useWebPush(client, api));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.state).toBe("prompt");

    await act(async () => {
      await result.current.enable();
    });

    expect(client.subscribeCalls).toEqual(["BPUB"]);
    expect(api.registerDevice).toHaveBeenCalledWith({
      channel: "web",
      endpoint: SUB.endpoint,
      p256dh: SUB.p256dh,
      auth: SUB.auth,
      platform: expect.any(String),
    } satisfies WebPushSubscriptionRegistration);
    expect(result.current.state).toBe("subscribed");
    expect(result.current.error).toBeNull();
  });

  it("surfaces a denied permission and never registers a destination", async () => {
    const client = new FakeClient();
    client.requestResult = "denied";
    const api = fakeApi();
    const { result } = renderHook(() => useWebPush(client, api));

    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.enable();
    });

    expect(result.current.state).toBe("denied");
    expect(api.registerDevice).not.toHaveBeenCalled();
    expect(client.subscribeCalls).toEqual([]);
  });

  it("disables: unregisters the destination and drops the browser subscription", async () => {
    const client = new FakeClient();
    client.subscription = SUB;
    client.permissionValue = "granted";
    const api = fakeApi();
    const { result } = renderHook(() => useWebPush(client, api));

    await waitFor(() => expect(result.current.state).toBe("subscribed"));

    await act(async () => {
      await result.current.disable();
    });

    expect(api.unregisterDevice).toHaveBeenCalledWith(SUB.endpoint);
    expect(client.unsubscribeCalls).toBe(1);
    expect(result.current.state).toBe("granted");
  });

  it("surfaces a registration failure without claiming success", async () => {
    const client = new FakeClient();
    const api = fakeApi({
      registerDevice: vi.fn(async () => {
        throw new Error("server rejected the destination");
      }),
    });
    const { result } = renderHook(() => useWebPush(client, api));

    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.enable();
    });

    expect(result.current.error).toBe("server rejected the destination");
    expect(result.current.state).not.toBe("subscribed");
  });

  it("surfaces a configuration load failure", async () => {
    const api = fakeApi({
      config: vi.fn(async () => {
        throw new Error("network down");
      }),
    });
    const { result } = renderHook(() => useWebPush(new FakeClient(), api));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("network down");
    expect(result.current.state).toBe("disabled");
  });
});
