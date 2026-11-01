import { derivePushUiState, subscriptionToPayload, urlBase64ToUint8Array } from "./webpush";

describe("derivePushUiState", () => {
  const base = {
    supported: true,
    serverEnabled: true,
    permission: "default" as NotificationPermission,
    subscribed: false,
  };

  it("reports unsupported before anything else", () => {
    expect(derivePushUiState({ ...base, supported: false, subscribed: true })).toBe("unsupported");
  });

  it("reports the server as disabled when it cannot send", () => {
    expect(derivePushUiState({ ...base, serverEnabled: false })).toBe("disabled");
  });

  it("reports a blocked permission and never a subscription", () => {
    expect(derivePushUiState({ ...base, permission: "denied", subscribed: true })).toBe("denied");
  });

  it("prefers a live subscription over a bare granted permission", () => {
    expect(derivePushUiState({ ...base, permission: "granted", subscribed: true })).toBe(
      "subscribed",
    );
  });

  it("distinguishes granted-but-unregistered from not-yet-asked", () => {
    expect(derivePushUiState({ ...base, permission: "granted" })).toBe("granted");
    expect(derivePushUiState({ ...base, permission: "default" })).toBe("prompt");
  });
});

describe("urlBase64ToUint8Array", () => {
  it("decodes a base64url value into the bytes it represents", () => {
    // base64url of "test" (standard base64 "dGVzdA==", no padding here).
    expect(Array.from(urlBase64ToUint8Array("dGVzdA"))).toEqual([116, 101, 115, 116]);
  });

  it("restores padding and translates the url-safe alphabet", () => {
    // A value containing both '-' and '_' must decode without throwing.
    const decoded = urlBase64ToUint8Array("A-_B");
    expect(decoded.length).toBe(3);
  });
});

describe("subscriptionToPayload", () => {
  function fakeSubscription(toJSONValue: unknown): PushSubscription {
    return { toJSON: () => toJSONValue } as unknown as PushSubscription;
  }

  it("extracts the endpoint and both client keys", () => {
    const payload = subscriptionToPayload(
      fakeSubscription({
        endpoint: "https://push.example/abc",
        keys: { p256dh: "BPUB", auth: "AUTH" },
      }),
    );
    expect(payload).toEqual({ endpoint: "https://push.example/abc", p256dh: "BPUB", auth: "AUTH" });
  });

  it("throws when the browser returns an incomplete subscription", () => {
    expect(() => subscriptionToPayload(fakeSubscription({ endpoint: "", keys: {} }))).toThrow(
      /incomplete push subscription/i,
    );
  });
});
