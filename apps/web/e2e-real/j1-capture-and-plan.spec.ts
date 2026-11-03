import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import {
  chooseTaskProperty,
  chooseTimeZone,
  dateIn,
  ensureOwner,
  expectTaskSaved,
  taskProperty,
} from "./helpers";

/**
 * MU-01 journey J1 — capture and plan (docs/ROADMAP.md, MU):
 * add "Buy milk" on Today, open it, set priority High and due tomorrow; it shows in Today
 * immediately after capture, moves to Upcoming after the date edit, survives a reload, and a stale
 * second-tab edit shows a conflict. Runs against the real API and a fresh database. Since UX-04 the
 * detail saves each property by itself (no Save button); specs wait for the "Saved" indicator.
 */
const ZONE = "Europe/Stockholm";
test.use({ timezoneId: ZONE, locale: "en-GB" });

const dialog = (page: Page) =>
  page.getByRole("dialog", { name: "Task details" });

test("J1: capture on Today, plan it for tomorrow, reload, and see a stale edit conflict", async ({
  page,
  context,
}) => {
  await ensureOwner(page);
  const title = "Buy milk (J1)";
  const tomorrow = dateIn(ZONE, 1);

  // Capture on Today: due today, visible immediately without a reload.
  await page.goto("/");
  await page.getByLabel("Task title").fill(title);
  await page.getByRole("button", { name: "Add" }).click();
  await expect(
    page.getByRole("button", { name: `Open ${title}` }),
  ).toBeVisible();
  await expect(page.getByLabel("Task title")).toHaveValue("");

  // Enter opens the detail (keyboard), the title is focused for editing.
  await page.getByRole("button", { name: `Open ${title}` }).focus();
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByLabel("Title")).toHaveValue(title);
  // The capture put the due date on today, as a date-only due (no time).
  await expect(dialog(page).getByLabel("Due date", { exact: true })).toHaveValue(
    dateIn(ZONE, 0),
  );
  await expect(dialog(page).getByLabel("Due time")).toHaveValue("");

  // Plan it: priority High, due tomorrow.
  await chooseTaskProperty(page, "Priority", "High");
  await dialog(page).getByLabel("Due date", { exact: true }).fill(tomorrow);
  await expect(dialog(page).getByRole("button", { name: "Save" })).toHaveCount(0);

  // Esc saves what is pending, closes and returns focus to the page; the task has left Today.
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toBeHidden();
  await expect(
    page.getByRole("button", { name: `Open ${title}` }),
  ).toBeHidden();

  // It is now in Upcoming, with its priority, and survives a reload.
  await page.getByRole("link", { name: "Upcoming" }).click();
  await expect(
    page.getByRole("button", { name: `Open ${title}` }),
  ).toBeVisible();
  await page.reload();
  const row = page.getByRole("listitem").filter({ hasText: title });
  await expect(row).toBeVisible();
  await expect(row.getByText("High", { exact: true })).toBeVisible();

  // The saved values persisted on the server.
  await page.getByRole("button", { name: `Open ${title}` }).click();
  await expect(taskProperty(page, "Priority")).toContainText("High");
  await expect(dialog(page).getByLabel("Due date", { exact: true })).toHaveValue(tomorrow);
  await page.keyboard.press("Escape");

  // A second tab opens the same task...
  const other = await context.newPage();
  await other.goto("/upcoming");
  await other.getByRole("button", { name: `Open ${title}` }).click();
  await expect(dialog(other).getByLabel("Title")).toHaveValue(title);

  // ...the first tab edits and saves it...
  await page.getByRole("button", { name: `Open ${title}` }).click();
  await dialog(page).getByLabel("Title").fill(`${title} edited`);
  await dialog(page).getByLabel("Title").press("Enter");
  await expectTaskSaved(page);

  // ...so the stale second tab gets a conflict, not a silent overwrite.
  await chooseTaskProperty(other, "Priority", "Urgent");
  await expect(other.getByText(/changed somewhere else/i)).toBeVisible();
  await expect(taskProperty(other, "Priority")).toContainText("Urgent");
  await dialog(other)
    .getByRole("button", { name: "Load latest version" })
    .click();
  await expect(dialog(other).getByLabel("Title")).toHaveValue(
    `${title} edited`,
  );
  await expect(taskProperty(other, "Priority")).toContainText("High");
  await other.close();
});

test("J1: every field can be edited, saved and read back after a reload", async ({
  page,
}) => {
  await ensureOwner(page);
  const title = "Plan the offsite (J1 fields)";
  await page.goto("/inbox");
  await page.getByLabel("Task title").fill(title);
  await page.getByRole("button", { name: "Add" }).click();
  await page.getByRole("button", { name: `Open ${title}` }).click();

  const panel = dialog(page);
  await panel.getByLabel("Title").fill(`${title} v2`);
  await panel
    .getByLabel("Description")
    .fill("Book the venue\nand the catering");
  await chooseTaskProperty(page, "Status", "In progress");
  await chooseTaskProperty(page, "Priority", "Medium");
  await panel.getByLabel("Due date", { exact: true }).fill(dateIn(ZONE, 5));
  await panel.getByLabel("Due time").fill("09:30");
  await chooseTimeZone(page, "Asia/Tokyo");
  await panel.getByLabel("Start", { exact: true }).fill(`${dateIn(ZONE, 2)}T08:15`);
  await panel.getByLabel("Add a tag").fill("work, Offsite ,work");
  await panel.getByLabel("Add a tag").press("Enter");
  await expectTaskSaved(page);
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();

  // In-progress tasks leave the Inbox; find it on the Board, then reload and read everything back.
  await page.goto("/board");
  await page.reload();
  await page.getByRole("button", { name: `Open ${title} v2` }).click();
  await expect(panel.getByLabel("Title")).toHaveValue(`${title} v2`);
  await expect(panel.getByLabel("Description")).toHaveValue(
    "Book the venue\nand the catering",
  );
  await expect(taskProperty(page, "Status")).toContainText("In progress");
  await expect(taskProperty(page, "Priority")).toContainText("Medium");
  await expect(panel.getByLabel("Due date", { exact: true })).toHaveValue(dateIn(ZONE, 5));
  await expect(panel.getByLabel("Due time")).toHaveValue("09:30");
  await expect(taskProperty(page, "Time zone")).toContainText("Asia/Tokyo");
  await expect(panel.getByLabel("Start", { exact: true })).toHaveValue(
    `${dateIn(ZONE, 2)}T08:15`,
  );
  await expect(panel.getByRole("list", { name: "Tags" }).getByRole("listitem")).toHaveText([
    "#Offsite",
    "#work",
  ]);
});

test("J1: the server's validation message is shown verbatim and nothing is lost", async ({
  page,
}) => {
  await ensureOwner(page);
  const title = "Validate me (J1)";
  await page.goto("/inbox");
  await page.getByLabel("Task title").fill(title);
  await page.getByRole("button", { name: "Add" }).click();
  await page.getByRole("button", { name: `Open ${title}` }).click();

  const panel = dialog(page);
  await panel.getByLabel("Title").fill("");
  await panel.getByLabel("Title").blur();
  await expect(panel.getByRole("alert")).toContainText(
    "title: String should have at least 1 character",
  );
  await expect(panel.getByLabel("Title")).toHaveValue("");

  await panel.getByLabel("Title").fill(title);
  await panel.getByLabel("Title").blur();
  await chooseTimeZone(page, "Mars/Olympus");
  await expect(panel.getByRole("alert")).toContainText("time_zone");
  await expect(panel.getByRole("alert")).not.toContainText("Unprocessable");
});

test("J1: a task can be deleted from the detail and the delete undone", async ({
  page,
}) => {
  await ensureOwner(page);
  const title = "Delete and undo (J1)";
  await page.goto("/inbox");
  await page.getByLabel("Task title").fill(title);
  await page.getByRole("button", { name: "Add" }).click();
  await page.getByRole("button", { name: `Open ${title}` }).click();
  await dialog(page).getByRole("button", { name: "Task options" }).click();
  await page.getByRole("menuitem", { name: "Delete task" }).click();

  await expect(dialog(page)).toBeHidden();
  await expect(
    page.getByRole("button", { name: `Open ${title}` }),
  ).toBeHidden();
  await expect(page.getByRole("status")).toContainText(`Deleted “${title}”`);

  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(
    page.getByRole("button", { name: `Open ${title}` }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: `Open ${title}` }),
  ).toBeVisible();
});

test("J1: on a narrow screen the detail fills the whole viewport (full page)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await ensureOwner(page);
  const title = "Narrow screen (J1)";
  await page.goto("/inbox");
  await page.getByLabel("Task title").fill(title);
  await page.getByRole("button", { name: "Add" }).click();
  await page.getByRole("button", { name: `Open ${title}` }).click();
  const box = await dialog(page).boundingBox();
  expect(box).not.toBeNull();
  expect(Math.round(box!.width)).toBe(375);
  expect(Math.round(box!.height)).toBe(800);
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toBeHidden();
});
