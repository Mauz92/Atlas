import { expect, test, type Page } from "@playwright/test";

import { USER } from "./helpers";

/**
 * M8-02 Web Push consent E2E suite (real browser, deterministic).
 *
 * Drives the real `/notifications` permission surface in Chromium. The browser push APIs
 * (`Notification`, `navigator.serviceWorker`, `PushManager`) are stubbed via an init script so no
 * real push service is contacted (AGENTS.md §13: deterministic, isolated; §11: no real data), and the
 * HTTP API is intercepted. The tests assert the behaviour the M8-02 acceptance requires:
 *
 *   1. granted permission → the browser is subscribed with the VAPID key and the destination is
 *      registered via `POST /api/notifications/devices`, then the UI reports notifications on;
 *   2. denied permission → a clear "blocked" state with no enable action;
 *   3. a server without VAPID keys → a clear "unavailable" state.
 *
 * A real push *delivery* to the browser is not exercised here (it needs a push service); it is
 * recorded `NOT RUN` in `ACCEPTANCE.md`.
 */

// A syntactically valid base64url VAPID public key the client passes to `PushManager.subscribe`.
const VAPID_PUBLIC_KEY =
  "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";

const PUSH_ENDPOINT = "https://push.example.test/sub/abc123";

interface PushMocks {
  /** The destination payloads the app registered via `POST /api/notifications/devices`. */
  readonly registrations: Record<string, unknown>[];
  /** The endpoints the app unregistered via `DELETE /api/notifications/devices`. */
  readonly unregistrations: string[];
}

/**
 * Stub the push-capable browser surface and intercept the API. `initial` is the permission the
 * browser starts in; `serverEnabled` controls whether the mocked server advertises VAPID keys.
 */
async function installPushMocks(
  page: Page,
  { initial = "default", serverEnabled = true }: { initial?: NotificationPermission; serverEnabled?: boolean } = {},
): Promise<PushMocks> {
  await page.addInitScript(
    ({ initialPermission, vapidSupported }) => {
      // `Notification` — a mutable `permission` plus a `requestPermission` that grants.
      let permission: NotificationPermission = initialPermission;
      const NotificationStub = Object.assign(function () {}, {
        get permission() {
          return permission;
        },
        requestPermission: async () => {
          permission = "granted";
          return permission;
        },
      });
      Object.defineProperty(window, "Notification", {
        configurable: true,
        writable: true,
        value: NotificationStub,
      });

      if (!vapidSupported) {
        return; // no PushManager → the client reports "unsupported"
      }

      let current: unknown = null;
      const subscription = {
        endpoint: "https://push.example.test/sub/abc123",
        toJSON: () => ({
          endpoint: "https://push.example.test/sub/abc123",
          keys: { p256dh: "p256dh-key", auth: "auth-key" },
        }),
        unsubscribe: async () => {
          current = null;
          return true;
        },
      };
      const registration = {
        pushManager: {
          getSubscription: async () => current,
          subscribe: async () => {
            current = subscription;
            return subscription;
          },
        },
      };
      Object.defineProperty(window, "PushManager", {
        configurable: true,
        writable: true,
        value: function () {},
      });
      Object.defineProperty(navigator, "serviceWorker", {
        configurable: true,
        get: () => ({
          register: async () => registration,
          ready: Promise.resolve(registration),
          getRegistration: async () => registration,
        }),
      });
    },
    { initialPermission: initial, vapidSupported: true },
  );

  const registrations: Record<string, unknown>[] = [];
  const unregistrations: string[] = [];

  await page.route("**/api/setup/status", (route) =>
    route.fulfill({ json: { setup_required: false } }),
  );
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: USER }));
  await page.route("**/api/changes**", (route) =>
    route.fulfill({
      json: { changes: [], since: 0, next_since: 0, has_more: false, resync_required: false },
    }),
  );
  await page.route("**/api/notifications/config", (route) =>
    route.fulfill({
      json: serverEnabled
        ? { enabled: true, vapid_public_key: VAPID_PUBLIC_KEY }
        : { enabled: false, vapid_public_key: null },
    }),
  );
  await page.route("**/api/notifications/devices**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "POST") {
      registrations.push((request.postDataJSON() ?? {}) as Record<string, unknown>);
      await route.fulfill({ status: 201, json: { id: "device-1", channel: "web" } });
      return;
    }
    if (request.method() === "DELETE") {
      unregistrations.push(url.searchParams.get("endpoint") ?? "");
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    await route.fulfill({ json: { devices: [] } });
  });

  return { registrations, unregistrations };
}

test.describe("web push consent (real UI, mocked browser + API)", () => {
  test("granted permission subscribes this browser and registers the destination", async ({
    page,
  }) => {
    const mocks = await installPushMocks(page, { initial: "default" });

    await page.goto("/notifications");
    await expect(
      page.getByRole("heading", { name: "Turn on desktop notifications" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Enable notifications" }).click();

    await expect(page.getByRole("heading", { name: "Notifications are on" })).toBeVisible();
    expect(mocks.registrations).toHaveLength(1);
    expect(mocks.registrations[0]).toMatchObject({
      channel: "web",
      endpoint: PUSH_ENDPOINT,
      p256dh: "p256dh-key",
      auth: "auth-key",
    });
  });

  test("denied permission shows a blocked state with no enable action", async ({ page }) => {
    await installPushMocks(page, { initial: "denied" });

    await page.goto("/notifications");
    await expect(page.getByRole("heading", { name: "Notifications are blocked" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Enable notifications" })).toHaveCount(0);
  });

  test("a server without VAPID keys reports notifications unavailable", async ({ page }) => {
    await installPushMocks(page, { initial: "default", serverEnabled: false });

    await page.goto("/notifications");
    await expect(
      page.getByRole("heading", { name: "Notifications aren't available on this server" }),
    ).toBeVisible();
  });
});
