import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { apiCall, chooseTaskProperty, dateIn, ensureOwner, expectTaskSaved } from "./helpers";

/**
 * MU-04 — recurrence, subtasks and reminders in the task detail (docs/ROADMAP.md, MU). Real API
 * and a fresh database; tasks are created through the API (capture is not under test) with unique
 * titles, since journeys share a database. The preview, validation messages and the generated next
 * occurrence all come from the server and are asserted as such.
 */
const ZONE = "Europe/Stockholm";
test.use({ timezoneId: ZONE, locale: "en-GB" });

const panel = (page: Page) =>
  page.getByRole("dialog", { name: "Task details" });

async function openTask(page: Page, title: string) {
  await page.goto(`/tasks?q=${encodeURIComponent(title)}`);
  await page
    .getByRole("button", { name: `Open ${title}`, exact: true })
    .click();
  await expect(panel(page).getByLabel("Title")).toHaveValue(title);
}

async function create(
  page: Page,
  title: string,
  fields: Record<string, unknown> = {},
) {
  return apiCall<{ id: string }>(page, "POST", "/api/tasks", {
    title,
    status: "next",
    time_zone: ZONE,
    due_at: `${dateIn(ZONE, 2)}T09:00:00`,
    ...fields,
  });
}

test("repeat: server preview and validation, completing shows the next occurrence, series ends", async ({
  page,
}) => {
  await ensureOwner(page);
  const title = "MU04 water plants";
  await create(page, title);
  await openTask(page, title);

  // A preset previews the server's next occurrences.
  await panel(page).getByLabel("Repeat").selectOption("weekly");
  await expect(
    panel(page)
      .getByRole("list", { name: "Next occurrences" })
      .getByRole("listitem"),
  ).toHaveCount(5);

  // The preset saved by itself (UX-04 autosave).
  await expectTaskSaved(page);

  // A bad custom rule shows the server's message as is; it is sent only when the field is left,
  // and the typed text stays.
  await panel(page).getByLabel("Repeat").selectOption("custom");
  await panel(page).getByLabel("Custom rule").fill("FREQ=SOMETIMES");
  await expect(panel(page).getByRole("alert")).toContainText(
    "invalid recurrence rule",
  );
  await panel(page).getByLabel("Custom rule").blur();
  await expect(
    panel(page).getByRole("alert").filter({ hasText: "recurrence_rule" }),
  ).toContainText("invalid recurrence rule");
  await expect(panel(page).getByLabel("Custom rule")).toHaveValue("FREQ=SOMETIMES");

  // A bounded custom rule saves and survives a reload.
  await panel(page).getByLabel("Custom rule").fill("FREQ=DAILY;COUNT=2");
  await expect(
    panel(page)
      .getByRole("list", { name: "Next occurrences" })
      .getByRole("listitem"),
  ).toHaveCount(2);
  await panel(page).getByLabel("Custom rule").press("Enter");
  await expectTaskSaved(page);
  await openTask(page, title);
  await expect(panel(page).getByLabel("Repeat")).toHaveValue("custom");
  await expect(panel(page).getByLabel("Custom rule")).toHaveValue(
    "FREQ=DAILY;COUNT=2",
  );

  // Completing it completes only this occurrence; the next one is shown and opens.
  await chooseTaskProperty(page, "Status", "Completed");
  await expect(
    panel(page).getByText(/Completed\. Next occurrence:/),
  ).toBeVisible();
  await panel(page)
    .getByRole("button", { name: "Open next occurrence" })
    .click();
  await expect(panel(page).getByLabel("Due date", { exact: true })).toHaveValue(dateIn(ZONE, 3));
  await expect(panel(page).getByLabel("Repeat")).toBeDisabled();
  const open = await apiCall<{ tasks: { status: string }[] }>(
    page,
    "GET",
    `/api/tasks?q=${encodeURIComponent(title)}`,
  );
  expect(open.tasks.map((t) => t.status).sort()).toEqual([
    "completed",
    "inbox",
  ]);

  // COUNT=2: completing the second occurrence ends the series.
  await chooseTaskProperty(page, "Status", "Completed");
  await expect(
    panel(page).getByText(/last occurrence of the series/),
  ).toBeVisible();
  const after = await apiCall<{ tasks: { status: string }[] }>(
    page,
    "GET",
    `/api/tasks?q=${encodeURIComponent(title)}`,
  );
  expect(after.tasks.map((t) => t.status)).toEqual(["completed", "completed"]);
});

test("subtasks with progress and a per-task reminder override", async ({
  page,
}) => {
  await ensureOwner(page);
  const title = "MU04 plan trip";
  await create(page, title);
  await openTask(page, title);
  const subtasks = panel(page).getByRole("region", { name: "Subtasks" });

  // Add, complete, open (and come back), remove; progress follows the server's rollup.
  for (const sub of ["MU04 pack bags", "MU04 book taxi"]) {
    await subtasks.getByLabel("New subtask").fill(sub);
    await subtasks.getByRole("button", { name: "Add subtask" }).click();
    await expect(subtasks.getByText(sub, { exact: true })).toBeVisible();
  }
  await expect(subtasks.getByText("0/2 done")).toBeVisible();
  await subtasks.getByLabel("Complete MU04 pack bags").click();
  await expect(subtasks.getByText("1/2 done")).toBeVisible();

  await subtasks
    .getByRole("button", { name: "Open subtask MU04 book taxi" })
    .click();
  await expect(panel(page).getByLabel("Title")).toHaveValue("MU04 book taxi");
  await panel(page).getByRole("button", { name: "Open parent task" }).click();
  await expect(panel(page).getByLabel("Title")).toHaveValue(title);

  await subtasks.getByRole("button", { name: "Remove MU04 book taxi" }).click();
  await expect(subtasks.getByText("1/1 done")).toBeVisible();
  // The list behind the panel shows the rollup too.
  await expect(page.getByText("1/1 subtasks")).toBeVisible();

  // Reminder override: a preset, a server-rejected custom value, then back to the default.
  const reminder = panel(page).getByRole("region", { name: "Reminder" });
  const timing = reminder.getByLabel("Reminder timing for this task");
  // UX-04: a choice saves itself; custom values save when a field is left.
  await timing.selectOption("1d-9am");
  await expect(reminder.getByRole("status")).toContainText(
    "1 day before at 09:00",
  );
  await expect(reminder.getByRole("status")).toContainText("next reminder");

  await timing.selectOption("custom");
  await reminder.getByLabel("Days before").fill("99");
  await reminder.getByLabel("Days before").blur();
  await expect(reminder.getByRole("alert")).toContainText("days_before");

  await page.reload();
  await page
    .getByRole("button", { name: `Open ${title}`, exact: true })
    .click();
  await expect(
    panel(page).getByLabel("Reminder timing for this task"),
  ).toHaveValue("1d-9am");
  await panel(page)
    .getByLabel("Reminder timing for this task")
    .selectOption("default");
  await expect(
    panel(page).getByRole("region", { name: "Reminder" }).getByRole("status"),
  ).toContainText("No reminder");
});
