import { expect, test } from "./fixtures";

/**
 * UX-01 theme before sign-in. The login (or first-run setup) screen follows the operating system's
 * theme, and a stored explicit choice is applied by `public/theme-init.js` before the app's own
 * script has run, so a dark-theme user never sees a light page first.
 */
const DARK_BG = "rgb(24, 24, 27)"; // --bg in dark
const LIGHT_BG = "rgb(255, 255, 255)"; // --bg in light

const authHeading = /Sign in to Atlas|Create your Atlas account/;

test.describe("theme before sign-in", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("login/setup follows a dark OS theme with no stored choice", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: authHeading })).toBeVisible();
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(DARK_BG);

    await page.emulateMedia({ colorScheme: "light" });
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor))
      .toBe(LIGHT_BG);
  });

  test("a stored choice is applied before the app script runs (no flash)", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.addInitScript(() => localStorage.setItem("atlas-theme", "dark"));
    // Hold the app's entry module back so the page is observed before React or styles.css load.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(/\/src\/main\.tsx/, async (route) => {
      await held;
      await route.continue();
    });
    const navigation = page.goto("/");
    await expect
      .poll(() => page.evaluate(() => document.readyState).catch(() => "loading"))
      .not.toBe("loading");
    const early = await page.evaluate(() => ({
      theme: document.documentElement.dataset.theme ?? null,
      scheme: getComputedStyle(document.documentElement).colorScheme,
      mounted: (document.getElementById("root")?.childElementCount ?? 0) > 0,
    }));
    expect(early).toEqual({ theme: "dark", scheme: "dark", mounted: false });
    release();
    await navigation;
    await expect(page.getByRole("heading", { name: authHeading })).toBeVisible();
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(DARK_BG);
  });
});
