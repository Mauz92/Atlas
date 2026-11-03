import AxeBuilder from "@axe-core/playwright";
import type { APIRequestContext, Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { ensureOwner, openSettingsSection, OWNER } from "./helpers";

/**
 * SYNC-06 — device credentials (ADR-0065) in a real browser against the real API: the bearer-token
 * journey a native client takes (sign in with the password, sync with the token, be signed out
 * from Settings, be refused at once) and the Settings → Devices layout under the touch rules and
 * axe. The token is only ever seen by the test's own HTTP client, never by the page. Not covered
 * here: the native clients themselves (SYNC-09/10).
 */
const BASE = () => process.env.ATLAS_E2E_BASE_URL!;

interface Registered {
  token: string;
  device: { id: string; name: string };
}

async function signInDevice(
  request: APIRequestContext,
  name: string,
  platform = "linux",
): Promise<Registered> {
  const response = await request.post(`${BASE()}/api/devices`, {
    data: { email: OWNER.email, password: OWNER.password, name, platform },
  });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()) as Registered;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function axeFindings(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"])
    .analyze();
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

test("a device signs in with the password, syncs with its token and is signed out from Settings", async ({
  page,
  playwright,
}) => {
  await ensureOwner(page);
  const device = await playwright.request.newContext(); // no cookies: a native client
  const { token, device: registered } = await signInDevice(device, "Journey laptop");
  expect(token).toMatch(/^atd_[A-Za-z0-9_-]{43}$/);

  // The token syncs the data endpoints without cookies or CSRF.
  const created = await device.post(`${BASE()}/api/tasks`, {
    headers: { ...bearer(token), "Atlas-Sync": "1", "Idempotency-Key": crypto.randomUUID() },
    data: { title: "SYNC06 made by a device" },
  });
  expect(created.status()).toBe(201);
  await page.goto("/tasks");
  await expect(page.getByText("SYNC06 made by a device")).toBeVisible();

  // It cannot reach the account: password, export, other devices.
  for (const [method, path] of [
    ["POST", "/api/auth/password"],
    ["GET", "/api/export"],
    ["POST", "/api/devices/revoke-all"],
  ] as const) {
    const refused = await device.fetch(`${BASE()}${path}`, { method, headers: bearer(token), data: {} });
    expect(refused.status(), path).toBe(403);
    expect((await refused.json()).error).toBe("forbidden_scope");
  }

  // The page's own cookie session cannot be abused through a bearer header: a bad token is a 401
  // even though the browser holds a valid session, and nothing is written.
  const rejected = await page.evaluate(async () => {
    const r = await fetch("/api/tasks", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", Authorization: `Bearer atd_${"A".repeat(43)}` },
      body: JSON.stringify({ title: "SYNC06 must not exist" }),
    });
    return r.status;
  });
  expect(rejected).toBe(401);
  await page.goto("/tasks");
  await expect(page.getByText("SYNC06 must not exist")).toHaveCount(0);

  // Settings → Devices lists it, with a last-seen time, and renames it.
  await page.goto("/settings");
  await openSettingsSection(page, "Devices");
  const list = page.getByRole("list", { name: "Signed-in devices" });
  const row = list.getByRole("listitem").filter({ hasText: "Journey laptop" });
  await expect(row).toContainText("Linux");
  await expect(row).toContainText(/Last seen/);
  await row.getByRole("button", { name: "Rename Journey laptop" }).click();
  await page.getByLabel("Name for Journey laptop").fill("Kim's desktop");
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByText("Renamed to Kim's desktop")).toBeVisible();
  const current = await device.get(`${BASE()}/api/devices/current`, { headers: bearer(token) });
  expect((await current.json()).name).toBe("Kim's desktop");
  expect((await current.json()).current).toBe(true);

  // Signing out asks once, then the very next request of the device is refused.
  await page.getByRole("button", { name: "Sign out Kim's desktop" }).click();
  await expect(page.getByRole("group", { name: "Sign out Kim's desktop?" })).toBeVisible();
  await page.getByRole("button", { name: "Keep signed in" }).click();
  expect((await device.get(`${BASE()}/api/tasks`, { headers: bearer(token) })).status()).toBe(200);
  await page.getByRole("button", { name: "Sign out Kim's desktop" }).click();
  await page.getByRole("button", { name: "Confirm: sign out Kim's desktop" }).click();
  await expect(page.getByText("Kim's desktop was signed out")).toBeVisible();
  const after = await device.get(`${BASE()}/api/tasks`, { headers: bearer(token) });
  expect(after.status()).toBe(401);
  expect((await after.json()).error).toBe("token_revoked");
  await expect(page.getByText(/No device is signed in/)).toBeVisible();

  // Signing in again works; "sign out all" ends every device.
  const second = await signInDevice(device, "Second device", "android");
  const third = await signInDevice(device, "Third device", "windows");
  await page.reload();
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await page.getByRole("button", { name: "Sign out all devices" }).click();
  await page.getByRole("button", { name: "Confirm: sign out all devices" }).click();
  await expect(page.getByText("2 devices were signed out")).toBeVisible();
  for (const t of [second.token, third.token]) {
    expect((await device.get(`${BASE()}/api/tasks`, { headers: bearer(t) })).status()).toBe(401);
  }
  // The browser session is untouched.
  await expect(page.getByText(/No device is signed in/)).toBeVisible();
  expect(registered.id).toBeTruthy();
  await device.dispose();
});

test("Settings → Devices fits a phone, meets the 44 px rule and is axe clean in both themes", async ({
  page,
  playwright,
}) => {
  test.setTimeout(120_000);
  await ensureOwner(page);
  const device = await playwright.request.newContext();
  await signInDevice(device, "SYNC06 Kim's work laptop with a rather long descriptive name that must wrap");
  await signInDevice(device, "SYNC06 Pixel", "android");

  for (const [width, height] of [
    [1440, 900],
    [390, 844],
    [360, 740],
  ]) {
    await page.setViewportSize({ width, height });
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      const label = `${width} ${scheme}`;
      await page.goto("/settings/devices");
      const list = page.getByRole("list", { name: "Signed-in devices" });
      await expect(list.getByRole("listitem")).toHaveCount(2);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `${label}: sideways scroll`).toBe(0);
      expect(await axeFindings(page), `${label}: list`).toEqual([]);

      // The three states of a row: rename, confirm, and the sign-out-all confirmation.
      await page.getByRole("button", { name: /^Rename SYNC06 Pixel/ }).click();
      expect(await axeFindings(page), `${label}: rename`).toEqual([]);
      await page.getByRole("button", { name: "Cancel" }).click();
      await page.getByRole("button", { name: "Sign out SYNC06 Pixel" }).click();
      expect(await axeFindings(page), `${label}: confirm`).toEqual([]);
      await page.getByRole("button", { name: "Keep signed in" }).click();
      await page.getByRole("button", { name: "Sign out all devices" }).click();
      expect(await axeFindings(page), `${label}: all`).toEqual([]);

      if (width < 700) {
        // Every visible control of the section is at least 44 px high and nothing is clipped.
        const small = await page.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>(".settings-body button, .settings-body input")]
            .filter((el) => el.offsetParent !== null)
            .map((el) => ({ el, r: el.getBoundingClientRect() }))
            .filter(({ r }) => r.height < 43.5)
            .map(({ el, r }) => `${el.tagName}[${el.getAttribute("aria-label") ?? el.textContent}] ${Math.round(r.height)}`),
        );
        expect(small, `${label}: small targets`).toEqual([]);
        const clipped = await page.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>(".device-row")].filter(
            (el) => el.scrollWidth > el.clientWidth + 1,
          ).length,
        );
        expect(clipped, `${label}: clipped rows`).toBe(0);
      }
    }
  }

  // Leave the shared database as found: nobody signed in.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/settings/devices");
  await page.getByRole("button", { name: "Sign out all devices" }).click();
  await page.getByRole("button", { name: "Confirm: sign out all devices" }).click();
  await expect(page.getByText(/No device is signed in/)).toBeVisible();
  await device.dispose();
});
