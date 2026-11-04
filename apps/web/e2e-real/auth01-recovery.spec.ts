import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { ensureOwner, openSettingsSection, OWNER, signOut } from "./helpers";

/**
 * AUTH-01 — account recovery (ADR-0067) in a real browser against the real API and database:
 * the code shown once at first-run setup behind an explicit acknowledgement, regeneration in
 * Settings, the "Forgot password?" journey (the old password stops working, every other session and
 * device is signed out, the used code is dead and a new one is issued), and layout under the touch
 * rules and axe in both themes at four widths.
 *
 * This file sorts before the other journeys, so in a full run its first test performs the run's
 * first-run setup. If an owner already exists (a single spec run against a used database), that
 * test skips and says so. The owner's password and sign-in are left as the other specs expect.
 */
const BASE = () => process.env.ATLAS_E2E_BASE_URL!;
const CODE_SHAPE = /^([0-9A-HJKMNP-TV-Z]{5}-){5}[0-9A-HJKMNP-TV-Z]{5}$/;
const SECOND_PASSWORD = "recovery-journey-pass-2";

async function axeFindings(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"])
    .analyze();
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

async function smallTargets(page: Page, scope: string): Promise<string[]> {
  return page.evaluate(
    (selector) =>
      [...document.querySelectorAll<HTMLElement>(`${selector} button, ${selector} input, ${selector} a`)]
        .filter((el) => el.offsetParent !== null)
        .filter((el) => !(el instanceof HTMLInputElement && el.type === "checkbox"))
        .map((el) => ({ el, r: el.getBoundingClientRect() }))
        .filter(({ r }) => r.height < 43.5)
        .map(({ el, r }) => `${el.tagName}[${el.getAttribute("aria-label") ?? el.textContent}] ${Math.round(r.height)}`),
    scope,
  );
}

/** A checkbox label is the target; it must reach 44 px on a phone too. */
async function smallCheckboxLabels(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("label:has(> input[type=checkbox])")]
      .filter((el) => el.offsetParent !== null && el.getBoundingClientRect().height < 43.5)
      .map((el) => `${el.textContent} ${Math.round(el.getBoundingClientRect().height)}`),
  );
}

async function sidewaysScroll(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

/** Settings → Account → Regenerate, through the UI; returns the new code after acknowledging it. */
async function regenerateInSettings(page: Page, password = OWNER.password): Promise<string> {
  await page.goto("/settings/account");
  await page.getByRole("button", { name: /^(Regenerate|Create recovery code)$/ }).click();
  await page.getByLabel("Your password", { exact: true }).fill(password);
  await page.getByRole("button", { name: /^Make a (new )?code$/ }).click();
  const code = (await page.getByTestId("recovery-code").textContent()) ?? "";
  expect(code).toMatch(CODE_SHAPE);
  await page.getByRole("checkbox", { name: "I have saved my recovery code" }).check();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByTestId("recovery-code")).toHaveCount(0);
  return code;
}

async function forgotPassword(
  page: Page,
  { email = OWNER.email, code, password }: { email?: string; code: string; password: string },
): Promise<void> {
  await page.getByLabel("Email").fill(email);
  await page.getByLabel(/^Recovery code/).fill(code);
  await page.getByLabel(/^New password/).fill(password);
  await page.getByLabel(/^Confirm new password/).fill(password);
  await page.getByRole("button", { name: "Change password" }).click();
}

test("first-run setup shows the recovery code once and will not continue until it is acknowledged", async ({
  page,
}) => {
  await page.goto("/");
  const setup = page.getByRole("heading", { name: "Create your Atlas account" });
  const login = page.getByRole("heading", { name: "Sign in to Atlas" });
  await expect(setup.or(login).first()).toBeVisible();
  test.skip(await login.isVisible(), "an owner already exists in this run's database");

  await page.getByLabel("Name").fill(OWNER.name);
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password").fill(OWNER.password);
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page.getByRole("heading", { name: "Save your recovery code" })).toBeVisible();
  const code = (await page.getByTestId("recovery-code").textContent()) ?? "";
  expect(code).toMatch(CODE_SHAPE);
  // The app is held back: no navigation, no way past the screen without acknowledging.
  await expect(page.getByRole("navigation", { name: "Destinations" })).toHaveCount(0);
  const proceed = page.getByRole("button", { name: "Continue to Atlas" });
  await expect(proceed).toBeDisabled();
  await expect(page.getByRole("button", { name: "Copy code" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Download as file" })).toBeVisible();

  // The download is a real file holding the code.
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download as file" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("atlas-recovery-code.txt");
  const { readFile } = await import("node:fs/promises");
  expect(await readFile((await download.path())!, "utf8")).toContain(code);

  // The code is in no storage and not in the URL.
  const leaked = await page.evaluate((c) => {
    const stores = [localStorage, sessionStorage].map((s) => JSON.stringify(Object.entries(s)));
    return [...stores, location.href].some((text) => text.includes(c));
  }, code);
  expect(leaked).toBe(false);

  // Layout and accessibility of the screen, both themes, four widths.
  for (const [width, height] of [
    [1440, 900],
    [768, 1024],
    [390, 844],
    [360, 740],
  ]) {
    await page.setViewportSize({ width, height });
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      const label = `${width} ${scheme}`;
      expect(await axeFindings(page), `${label}: axe`).toEqual([]);
      expect(await sidewaysScroll(page), `${label}: sideways scroll`).toBe(0);
      if (width < 700) {
        expect(await smallTargets(page, ".auth-page"), `${label}: small targets`).toEqual([]);
        expect(await smallCheckboxLabels(page), `${label}: checkbox label`).toEqual([]);
      }
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });

  await page.getByRole("checkbox", { name: "I have saved my recovery code" }).check();
  await expect(proceed).toBeEnabled();
  await proceed.click();
  await expect(page.getByRole("navigation", { name: "Destinations" })).toBeVisible();

  // Settings agrees it is set; the code itself is nowhere on the page.
  await page.goto("/settings/account");
  await expect(page.getByText(/^Set on /)).toBeVisible();
  expect(await page.content()).not.toContain(code);
});

test("Settings → Account regenerates the recovery code behind the password and shows it once", async ({
  page,
}) => {
  await ensureOwner(page);
  await page.goto("/settings");
  await openSettingsSection(page, "Account");
  await expect(page.getByRole("heading", { name: "Recovery code", level: 3 })).toBeVisible();
  await expect(page.getByText(/^Set on /)).toBeVisible();

  await page.getByRole("button", { name: "Regenerate" }).click();
  await page.getByLabel("Your password", { exact: true }).fill("not my password");
  await page.getByRole("button", { name: "Make a new code" }).click();
  await expect(page.getByRole("alert")).toContainText("Current password is incorrect");
  await expect(page.getByTestId("recovery-code")).toHaveCount(0);

  await page.getByLabel("Your password", { exact: true }).fill(OWNER.password);
  await page.getByRole("button", { name: "Make a new code" }).click();
  await expect(page.getByTestId("recovery-code")).toHaveText(CODE_SHAPE);
  const code = (await page.getByTestId("recovery-code").textContent()) ?? "";
  await expect(page.getByRole("button", { name: "Done" })).toBeDisabled();
  await page.getByRole("checkbox", { name: "I have saved my recovery code" }).check();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByTestId("recovery-code")).toHaveCount(0);
  await page.reload(); // gone for good
  expect(await page.content()).not.toContain(code);
  await expect(page.getByText(/^Set on /)).toBeVisible();
});

test("Forgot password: the code resets the password, signs every session and device out, and is replaced", async ({
  page,
  browser,
  playwright,
}) => {
  test.setTimeout(120_000);
  await ensureOwner(page);
  const oldCode = await regenerateInSettings(page);

  // A second browser with its own session, and a sync device with its own token.
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await otherPage.goto(BASE());
  await otherPage.getByLabel("Email").fill(OWNER.email);
  await otherPage.getByLabel("Password").fill(OWNER.password);
  await otherPage.getByRole("button", { name: "Sign in" }).click();
  await expect(otherPage.getByRole("navigation", { name: "Destinations" })).toBeVisible();
  const device = await playwright.request.newContext();
  const signedIn = await device.post(`${BASE()}/api/devices`, {
    data: { email: OWNER.email, password: OWNER.password, name: "AUTH01 laptop", platform: "linux" },
  });
  expect(signedIn.status()).toBe(201);
  const { token } = (await signedIn.json()) as { token: string };
  const bearer = { Authorization: `Bearer ${token}` };
  expect((await device.get(`${BASE()}/api/tasks`, { headers: bearer })).status()).toBe(200);

  // The forgetful owner arrives signed out.
  const forgetful = await browser.newContext();
  const forgot = await forgetful.newPage();
  await forgot.goto(BASE());
  await forgot.getByRole("button", { name: "Forgot password?" }).click();
  await expect(forgot.getByRole("heading", { name: "Forgot your password?" })).toBeVisible();

  // A wrong code is refused with a message that does not say which part was wrong.
  await forgotPassword(forgot, { code: "00000-00000-00000-00000-00000-00000", password: SECOND_PASSWORD });
  await expect(forgot.getByRole("alert")).toHaveText("That email and recovery code do not match.");
  // An unknown email gets the very same message.
  await forgotPassword(forgot, {
    email: "nobody@example.com",
    code: oldCode,
    password: SECOND_PASSWORD,
  });
  await expect(forgot.getByRole("alert")).toHaveText("That email and recovery code do not match.");

  // The right code, typed sloppily (lower case, spaces instead of dashes).
  await forgotPassword(forgot, {
    code: oldCode.toLowerCase().replaceAll("-", " "),
    password: SECOND_PASSWORD,
  });
  await expect(forgot.getByRole("heading", { name: "Password changed" })).toBeVisible();
  const newCode = (await forgot.getByTestId("recovery-code").textContent()) ?? "";
  expect(newCode).toMatch(CODE_SHAPE);
  expect(newCode).not.toBe(oldCode);
  await expect(forgot.getByRole("button", { name: "Back to sign in" })).toBeDisabled();
  await forgot.getByRole("checkbox", { name: "I have saved my recovery code" }).check();
  await forgot.getByRole("button", { name: "Back to sign in" }).click();
  await expect(forgot.getByRole("heading", { name: "Sign in to Atlas" })).toBeVisible();

  // Old password: no. New password: yes.
  await forgot.getByLabel("Email").fill(OWNER.email);
  await forgot.getByLabel("Password").fill(OWNER.password);
  await forgot.getByRole("button", { name: "Sign in" }).click();
  await expect(forgot.getByRole("alert")).toBeVisible();
  await forgot.getByLabel("Password").fill(SECOND_PASSWORD);
  await forgot.getByRole("button", { name: "Sign in" }).click();
  await expect(forgot.getByRole("navigation", { name: "Destinations" })).toBeVisible();

  // Every other session and device was signed out by the reset.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Sign in to Atlas" })).toBeVisible();
  await otherPage.reload();
  await expect(otherPage.getByRole("heading", { name: "Sign in to Atlas" })).toBeVisible();
  const after = await device.get(`${BASE()}/api/tasks`, { headers: bearer });
  expect(after.status()).toBe(401);
  expect((await after.json()).error).toBe("token_revoked");

  // The used code is dead.
  await signOut(forgot);
  await forgot.getByRole("button", { name: "Forgot password?" }).click();
  await forgotPassword(forgot, { code: oldCode, password: "an attacker chosen password" });
  await expect(forgot.getByRole("alert")).toHaveText("That email and recovery code do not match.");

  // Put the shared owner back as the other journeys expect: the new code resets it once more
  // (which also shows the replacement chain works), then the old password signs in again.
  await forgotPassword(forgot, { code: newCode, password: OWNER.password });
  await expect(forgot.getByRole("heading", { name: "Password changed" })).toBeVisible();
  await forgot.getByRole("checkbox", { name: "I have saved my recovery code" }).check();
  await forgot.getByRole("button", { name: "Back to sign in" }).click();
  await forgot.getByLabel("Email").fill(OWNER.email);
  await forgot.getByLabel("Password").fill(OWNER.password);
  await forgot.getByRole("button", { name: "Sign in" }).click();
  await expect(forgot.getByRole("navigation", { name: "Destinations" })).toBeVisible();

  await other.close();
  await forgetful.close();
  await device.dispose();
});

test("Sign in and Forgot password fit every width, meet the touch rule and are axe clean in both themes", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await ensureOwner(page);
  await signOut(page);
  for (const [width, height] of [
    [1440, 900],
    [768, 1024],
    [390, 844],
    [360, 740],
  ]) {
    await page.setViewportSize({ width, height });
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      const label = `${width} ${scheme}`;
      await page.goto("/");
      await expect(page.getByRole("heading", { name: "Sign in to Atlas" })).toBeVisible();
      expect(await axeFindings(page), `${label}: sign in`).toEqual([]);
      await page.getByRole("button", { name: "Forgot password?" }).click();
      await expect(page.getByRole("heading", { name: "Forgot your password?" })).toBeVisible();
      expect(await axeFindings(page), `${label}: forgot`).toEqual([]);
      // 16 px fields (no iOS zoom) and nothing off-screen
      const sizes = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLInputElement>(".auth-page input:not([type=checkbox])")].map(
          (el) => parseFloat(getComputedStyle(el).fontSize),
        ),
      );
      if (width < 700) expect(Math.min(...sizes), `${label}: field font`).toBeGreaterThanOrEqual(16);
      expect(await sidewaysScroll(page), `${label}: sideways scroll`).toBe(0);
      if (width < 700) {
        expect(await smallTargets(page, ".auth-page"), `${label}: small targets`).toEqual([]);
      }
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });
});

test("Settings → Account recovery row fits every width, meets the touch rule and is axe clean in both themes", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await ensureOwner(page);
  for (const [width, height] of [
    [1440, 900],
    [768, 1024],
    [390, 844],
    [360, 740],
  ]) {
    await page.setViewportSize({ width, height });
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      const label = `${width} ${scheme}`;
      await page.goto("/settings/account");
      await expect(page.getByText(/^Set on /)).toBeVisible();
      expect(await axeFindings(page), `${label}: row`).toEqual([]);
      await page.getByRole("button", { name: "Regenerate" }).click();
      expect(await axeFindings(page), `${label}: password form`).toEqual([]);
      await page.getByLabel("Your password", { exact: true }).fill(OWNER.password);
      await page.getByRole("button", { name: "Make a new code" }).click();
      await expect(page.getByTestId("recovery-code")).toBeVisible();
      expect(await axeFindings(page), `${label}: reveal`).toEqual([]);
      expect(await sidewaysScroll(page), `${label}: sideways scroll`).toBe(0);
      if (width < 700) {
        expect(await smallTargets(page, ".recovery-panel"), `${label}: small targets`).toEqual([]);
        expect(await smallCheckboxLabels(page), `${label}: checkbox label`).toEqual([]);
        // the code wraps instead of overflowing its box
        const overflow = await page.evaluate(() => {
          const el = document.querySelector<HTMLElement>("[data-testid=recovery-code]")!;
          return el.scrollWidth - el.clientWidth;
        });
        expect(overflow, `${label}: code overflow`).toBeLessThanOrEqual(0);
      }
      await page.getByRole("checkbox", { name: "I have saved my recovery code" }).check();
      await page.getByRole("button", { name: "Done" }).click();
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });
});
