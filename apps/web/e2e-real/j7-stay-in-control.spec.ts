import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "./fixtures";
import { OWNER, apiCall, ensureOwner, signIn } from "./helpers";

/**
 * MU-08 journey J7 — stay in control (docs/ROADMAP.md, MU). Real API, real database. Settings must
 * offer, and make work: the account (name, password), theme, reminder timing and notification
 * status, the data export, the backup status and the instance information. Also the keyboard
 * shortcut help. Server messages are asserted as the server wrote them.
 */
const NEW_PASSWORD = "journey-new-password-2";

const notesDir = () => {
  const dir = process.env.ATLAS_E2E_NOTES_DIR;
  if (!dir) throw new Error("ATLAS_E2E_NOTES_DIR is not set — global setup did not run");
  return dir;
};

test("J7: account, theme, reminders, export, backup status and instance info all work", async ({
  page,
  browser,
}) => {
  await ensureOwner(page);
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();

  // --- Account: the name -------------------------------------------------------------------
  const name = page.getByLabel("Display name");
  await name.fill("   ");
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByRole("alert")).toHaveText("display_name: Name must not be blank");
  await name.fill("J7 Renamed Owner");
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByText("Name saved")).toBeVisible();
  await expect(page.locator(".topbar")).toContainText("J7 Renamed Owner");
  await page.reload();
  await expect(page.getByLabel("Display name")).toHaveValue("J7 Renamed Owner");

  // --- Account: the password ---------------------------------------------------------------
  const fillPasswords = async (current: string, next: string) => {
    await page.getByLabel("Current password").fill(current);
    await page.getByLabel("New password", { exact: true }).fill(next);
    await page.getByLabel("Confirm new password").fill(next);
    await page.getByRole("button", { name: "Change password" }).click();
  };
  const otherDevice = await browser.newContext({ baseURL: process.env.ATLAS_E2E_BASE_URL });
  const other = await otherDevice.newPage();
  try {
    await other.goto("/");
    await signIn(other);
    await expect(other.getByRole("link", { name: "Inbox" })).toBeVisible();

    await fillPasswords("not the current one", NEW_PASSWORD);
    await expect(page.getByRole("alert")).toHaveText("Current password is incorrect");
    await fillPasswords(OWNER.password, OWNER.password);
    await expect(page.getByRole("alert")).toHaveText(
      "New password must differ from the current password",
    );

    await fillPasswords(OWNER.password, NEW_PASSWORD);
    await expect(page.getByText(/Password changed/)).toBeVisible();
    // This browser stays signed in (it was given a fresh session); the other device is signed out.
    await page.reload();
    await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
    await other.reload();
    await expect(other.getByRole("heading", { name: "Sign in to Atlas" })).toBeVisible();
  } finally {
    await otherDevice.close();
    // Put the shared owner's password back so the other journeys can sign in (also proves the new
    // password works as the "current" one).
    await fillPasswords(NEW_PASSWORD, OWNER.password);
    await expect(page.getByText(/Password changed/)).toBeVisible();
  }
  // Restore the owner's name for the other journeys.
  await name.fill(OWNER.name);
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByText("Name saved")).toBeVisible();

  // --- Theme ---------------------------------------------------------------------------------
  await page.getByRole("radio", { name: "Dark" }).check();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.getByRole("radio", { name: "Dark" })).toBeChecked();
  await page.getByRole("radio", { name: "Light" }).check();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  // --- Reminder timing and notification status ---------------------------------------------
  await expect(page.getByRole("heading", { name: /Notifications aren't available|Turn on desktop|can't show/ })).toBeVisible();
  await page.getByLabel("Reminder timing").selectOption({ label: "1 day before at 09:00" });
  await page.getByRole("button", { name: "Save reminder timing" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  const prefs = await apiCall<{ default: { days_before: number; at_time: string } | null }>(
    page,
    "GET",
    "/api/notifications/reminders",
  );
  expect(prefs.default).toEqual({ days_before: 1, at_time: "09:00" });
  // The default is shared by every journey in this run; turn it back off.
  await page.getByLabel("Reminder timing").selectOption({ label: "No reminder" });
  await page.getByRole("button", { name: "Save reminder timing" }).click();
  await expect(page.getByText("Reminders are off.")).toBeVisible();

  // --- Export ----------------------------------------------------------------------------------
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download export" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^atlas-export-.+\.zip$/);
  const bytes = await readFile((await download.path()) as string);
  expect(bytes.subarray(0, 2).toString("latin1")).toBe("PK");
  await expect(page.getByText(/Downloaded atlas-export-/)).toBeVisible();

  // --- Backup status and instance info -------------------------------------------------------
  const backups = page.getByRole("region", { name: "Backups" });
  await expect(backups).toContainText("not visible to the API");
  const backupDir = path.join(notesDir(), "backups");
  const set = path.join(backupDir, "atlas-backup-20261101T030000Z-e2e00001");
  try {
    await mkdir(set, { recursive: true });
    await writeFile(
      path.join(set, "manifest.json"),
      JSON.stringify({
        format: "atlas-backup",
        format_version: 1,
        backup_id: "20261101T030000Z-e2e00001",
        created_at: "2026-11-01T03:00:00+00:00",
        atlas_version: "0.1.0",
        parts: { database: { bytes: 2048 }, notes: { bytes: 500 } },
      }),
    );
    await page.reload();
    await expect(backups).toContainText("database 2.0 KB, notes 500 B");
    await expect(backups).toContainText("Last backup");
  } finally {
    await rm(backupDir, { recursive: true, force: true });
  }

  const info = await apiCall<{ version: string; migration_revision: string }>(page, "GET", "/api/instance");
  const instance = page.getByRole("region", { name: "Instance" });
  await expect(instance).toContainText(info.version);
  await expect(instance).toContainText(info.migration_revision);
  await expect(instance).toContainText("ok");

  // --- Keyboard shortcut help ----------------------------------------------------------------
  await page.getByLabel("Display name").fill("?");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeHidden();
  await page.getByLabel("Display name").fill(OWNER.name);
  await page.locator("h1").click();
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeHidden();
  await page.getByRole("button", { name: /Search · Ctrl K/ }).click();
  await page.getByRole("dialog", { name: "Command palette" }).getByRole("combobox").fill("shortcuts");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  await page.keyboard.press("Escape");
});
