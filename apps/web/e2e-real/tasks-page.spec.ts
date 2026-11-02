import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { apiCall, dateIn, ensureOwner } from "./helpers";

/**
 * MU-03 — the Tasks page (docs/ROADMAP.md, MU): find tasks with the server's filters, sort them,
 * keep a view as a saved shortcut, and act on several at once (complete, move, delete with undo).
 * The filter lives in the URL. Real API and a fresh database; tasks are created through the API
 * (capture is not under test) with a unique title prefix per test, since journeys share a database.
 */
const ZONE = "Europe/Stockholm";
test.use({ timezoneId: ZONE, locale: "en-GB" });

const rows = (page: Page) => page.locator("ul.task-list > li");
const titlesOf = async (page: Page) =>
  (await rows(page).locator(".task-title").allTextContents()).map((t) => t.trim());

/** Shared set-up: a project and three tasks under `prefix` (priority, due offset in days, project). */
async function seed(page: Page, prefix: string) {
  await ensureOwner(page);
  const project = await apiCall<{ id: string }>(page, "POST", "/api/projects", {
    name: `${prefix} Home`,
  });
  const target = await apiCall<{ id: string }>(page, "POST", "/api/projects", {
    name: `${prefix} Target`,
  });
  const make = (title: string, fields: Record<string, unknown>) =>
    apiCall(page, "POST", "/api/tasks", { title: `${prefix} ${title}`, status: "next", ...fields });
  await make("rent", { priority: "high", due_at: `${dateIn(ZONE, 2)}T12:00:00`, time_zone: ZONE, project_id: project.id });
  await make("laundry", { priority: "low" });
  await make("taxes", { priority: "urgent", due_at: `${dateIn(ZONE, 10)}T12:00:00`, time_zone: ZONE });
  return { project, target };
}

test("tasks page: filter, sort, URL state and saved filters", async ({ page }) => {
  await seed(page, "TPA");

  await page.goto("/tasks");
  await page.getByLabel("Search").fill("TPA");
  await expect(page).toHaveURL(/q=TPA/);
  await expect.poll(() => titlesOf(page)).toEqual(["TPA taxes", "TPA rent", "TPA laundry"]);

  // Sort is part of the URL.
  await page.getByLabel("Sort by").selectOption("due");
  await expect(page).toHaveURL(/sort=due/);
  await expect.poll(() => titlesOf(page)).toEqual(["TPA rent", "TPA taxes", "TPA laundry"]);

  // Priority, then project, then a due range; each narrows the list and survives a reload.
  await page.getByLabel("Priority", { exact: true }).selectOption("high");
  await expect.poll(() => titlesOf(page)).toEqual(["TPA rent"]);
  await page.reload();
  await expect(page.getByLabel("Priority", { exact: true })).toHaveValue("high");
  await expect.poll(() => titlesOf(page)).toEqual(["TPA rent"]);

  await page.getByLabel("Priority", { exact: true }).selectOption("");
  await page.getByLabel("Due to").fill(dateIn(ZONE, 5));
  await expect.poll(() => titlesOf(page)).toEqual(["TPA rent"]);
  await page.getByLabel("Due to").fill("");
  await page.getByLabel("Project", { exact: true }).selectOption({ label: "TPA Home" });
  await expect.poll(() => titlesOf(page)).toEqual(["TPA rent"]);

  // An inverted range is rejected by the server and its message is shown as is.
  await page.getByLabel("Project", { exact: true }).selectOption("");
  await page.getByLabel("Due from").fill(dateIn(ZONE, 8));
  await page.getByLabel("Due to").fill(dateIn(ZONE, 3));
  await expect(page.getByRole("alert")).toContainText("due range is inverted");

  // Save a view, leave, and come back through the shortcut; it persists across a reload.
  await page.getByRole("button", { name: "Reset filters" }).click();
  await page.getByLabel("Priority", { exact: true }).selectOption("urgent");
  await page.getByLabel("Saved filter name").fill("TPA urgent");
  await page.getByRole("button", { name: "Save this view" }).click();
  await page.goto("/tasks");
  await page.reload();
  await page.getByRole("link", { name: "TPA urgent" }).click();
  await expect(page).toHaveURL(/priority=urgent/);
  await expect(page.getByLabel("Priority", { exact: true })).toHaveValue("urgent");
  await expect.poll(async () => (await titlesOf(page)).includes("TPA taxes")).toBe(true);
});

test("tasks page: keyboard selection, bulk move, complete, delete and undo", async ({ page }) => {
  await seed(page, "TPB");

  await page.goto("/tasks?q=TPB");
  await expect.poll(() => titlesOf(page)).toHaveLength(3);

  // Keyboard: focus a checkbox and press Space.
  const first = page.getByLabel("Select TPB taxes");
  await first.focus();
  await page.keyboard.press("Space");
  await expect(first).toBeChecked();
  await expect(page.getByText("1 selected")).toBeVisible();

  // Move the whole selection to a project; the rows then name it.
  await page.getByLabel("Select all").check();
  await page.getByLabel("Move selected to project").selectOption({ label: "TPB Target" });
  await expect(rows(page).locator(".project-tag")).toHaveText(["TPB Target", "TPB Target", "TPB Target"]);

  // Complete two of them: they leave the default "open" list and show under Completed.
  await page.getByLabel("Select all").uncheck();
  await page.getByLabel("Select TPB rent").check();
  await page.getByLabel("Select TPB laundry").check();
  await page.getByRole("button", { name: "Complete selected" }).click();
  await expect.poll(() => titlesOf(page)).toEqual(["TPB taxes"]);
  await page.getByLabel("Status", { exact: true }).selectOption("completed");
  await expect.poll(() => titlesOf(page)).toHaveLength(2);

  // Delete both, then undo: they come back.
  await page.getByLabel("Select all").check();
  await page.getByRole("button", { name: "Delete selected" }).click();
  await expect(page.getByRole("status")).toContainText("Deleted 2 tasks.");
  await expect.poll(() => titlesOf(page)).toEqual([]);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => titlesOf(page)).toHaveLength(2);

  // A row opens the shared task detail, and Esc closes it.
  await page.getByRole("button", { name: "Open TPB rent" }).click();
  await expect(page.getByRole("dialog", { name: "Task details" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Task details" })).toBeHidden();
});
