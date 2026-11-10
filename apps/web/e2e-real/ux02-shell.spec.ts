import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { ensureOwner, rail } from "./helpers";

/**
 * UX-02 app shell, real API and database: keyboard-only navigation (skip link, rail, sidebar
 * sections, Ctrl+B), one active item per navigation, every old URL still resolving (`/day` lands on
 * Today), the status bar's offline state, and the phone layout (bottom nav, drawer with focus
 * management, no sideways scrolling).
 */
const OLD_URLS: [string, string][] = [
  ["/", "Today"],
  ["/inbox", "Inbox"],
  ["/upcoming", "Upcoming"],
  ["/week", "Week"],
  ["/tasks", "Tasks"],
  // The standalone Board is gone (ADR-0064): the old URL lands on Projects.
  ["/board", "Projects"],
  ["/projects", "Projects"],
  // The Calendar page exists since M5-07; Sync and Notifications are Settings sections since UX-08.
  ["/calendar", "Calendar"],
  ["/sync", "Settings"],
  ["/notifications", "Settings"],
  ["/notes", "Notes"],
  ["/search", "Search"],
  ["/settings", "Settings"],
];

/** axe WCAG 2 A/AA + best-practice findings for the shell states the MU-08 sweep does not open. */
async function axeIds(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"])
    .analyze();
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

test("UX-02: the shell works by keyboard, keeps old URLs and fits a phone", async ({ page }) => {
  await ensureOwner(page);
  const sidebarNav = page.getByRole("navigation", { name: "Main navigation" });
  const sidebar = page.getByRole("complementary", { name: "Sidebar" });

  // --- Skip link, then the rail by keyboard --------------------------------------------------
  await page.goto("/inbox");
  await expect(page.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main")).toBeFocused();

  await page.goto("/inbox");
  await expect(page.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible();
  await page.keyboard.press("Tab"); // skip link
  await page.keyboard.press("Tab"); // rail: Today
  await expect(rail(page).getByRole("link", { name: "Today" })).toBeFocused();
  await page.keyboard.press("Tab"); // Inbox
  await page.keyboard.press("Tab"); // Tasks
  await expect(rail(page).getByRole("link", { name: "Tasks" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(page.getByRole("heading", { name: "Tasks", level: 1 })).toBeVisible();
  await expect(sidebarNav.locator("[aria-current]")).toHaveCount(1);
  await expect(sidebarNav.locator('[aria-current="page"]')).toHaveText("Tasks");
  await expect(rail(page).locator("[aria-current]")).toHaveCount(1);

  // --- A collapsed sidebar section opens by keyboard; More holds Settings --------------------
  const more = page.getByRole("button", { name: "More" });
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await more.focus();
  await page.keyboard.press("Enter");
  await expect(more).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Tab"); // Search
  await page.keyboard.press("Tab"); // Settings
  await expect(sidebarNav.getByRole("link", { name: "Settings" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
  await expect(sidebarNav.locator('[aria-current="page"]')).toHaveText("Settings");
  await expect(rail(page).getByRole("link", { name: "Settings" })).toHaveAttribute("aria-current", "page");
  // A section of Settings keeps the same single active item.
  await page.goto("/settings/sync");
  await expect(page.getByRole("heading", { name: "Sync", level: 2 })).toBeVisible();
  await expect(sidebarNav.locator("[aria-current]")).toHaveCount(1);
  await expect(sidebarNav.locator('[aria-current="page"]')).toHaveText("Settings");

  // --- Ctrl+B hides the sidebar, remembered across a reload ---------------------------------
  await page.keyboard.press("Control+b");
  await expect(sidebar).toBeHidden();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
  await expect(sidebar).toBeHidden();
  await expect(rail(page).getByRole("button", { name: "Show sidebar" })).toBeVisible();
  expect(await axeIds(page), "axe with the sidebar collapsed").toEqual([]);
  await page.keyboard.press("Control+b");
  await expect(sidebar).toBeVisible();

  // --- Old URLs resolve; /day lands on Today -------------------------------------------------
  for (const [url, heading] of OLD_URLS) {
    await page.goto(url);
    await expect(page.getByRole("heading", { name: heading, level: 1 })).toBeVisible();
    await expect(sidebarNav.locator("[aria-current]")).toHaveCount(1);
  }
  for (const [from, to] of [
    ["/sync", "/settings/sync"],
    ["/notifications", "/settings/notifications"],
  ]) {
    await page.goto(from);
    await expect(page).toHaveURL(new RegExp(`${to}$`));
  }
  await page.goto("/day");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "Today", level: 1 })).toBeVisible();

  // --- Status bar: offline ------------------------------------------------------------------
  const status = page.getByRole("contentinfo", { name: "Status bar" });
  await expect(status).toContainText("Synced");
  await page.context().setOffline(true);
  await expect(status).toContainText("Offline");
  await page.context().setOffline(false);
  await expect(status).toContainText("Synced");

  // --- Phone: bottom nav, drawer with focus management, no sideways scroll ------------------
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/");
  const bottom = page.getByRole("navigation", { name: "Bottom navigation" });
  await expect(bottom.getByRole("link")).toHaveCount(5);
  await expect(bottom.getByRole("link", { name: "Today" })).toHaveAttribute("aria-current", "page");
  await expect(sidebar).toBeHidden();
  await expect(rail(page)).toBeHidden();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBe(0);

  const menu = page.getByRole("button", { name: "Open menu" });
  await menu.focus();
  await page.keyboard.press("Enter");
  await expect(sidebar).toBeVisible();
  await expect(page.getByRole("button", { name: "Close menu" })).toBeFocused();
  expect(await axeIds(page), "axe with the phone drawer open").toEqual([]);
  await page.keyboard.press("Escape");
  await expect(sidebar).toBeHidden();
  await expect(menu).toBeFocused();

  await menu.click();
  await sidebarNav.getByRole("link", { name: "Notes" }).click();
  await expect(page.getByRole("heading", { name: "Notes", level: 1 })).toBeVisible();
  await expect(sidebar).toBeHidden();
});
