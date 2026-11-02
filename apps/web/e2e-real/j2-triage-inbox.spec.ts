import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { apiCall, dateIn, ensureOwner } from "./helpers";

/**
 * MU-01 journey J2 — triage the inbox (docs/ROADMAP.md, MU): process five inbox items. Each can be
 * scheduled (today / tomorrow / pick a date), filed to a project, or deleted (with undo) in at most
 * two interactions, driven here from the keyboard (focus a control, press Enter). Since UX-03 the
 * row shows a checkbox and a "…" menu; "today", "pick a date" and "move to a project" are the
 * row's hover/focus quick actions, and tomorrow / delete are one menu item away. Real API and a
 * fresh database.
 */
const ZONE = "Europe/Stockholm";
test.use({ timezoneId: ZONE, locale: "en-GB" });

const titles = {
  today: "J2 call the vet",
  tomorrow: "J2 book flights",
  picked: "J2 renew passport",
  filed: "J2 paint the fence",
  deleted: "J2 old idea",
};

/** Activate a control the way a keyboard user does: focus it, press Enter. */
async function press(page: Page, name: string) {
  const control = page.getByRole("button", { name, exact: true });
  await control.focus();
  await page.keyboard.press("Enter");
}

/** Activate an item of the open menu from the keyboard. */
async function pressItem(page: Page, name: string) {
  const item = page
    .getByRole("menuitem", { name, exact: true })
    .or(page.getByRole("menuitemradio", { name, exact: true }));
  await item.focus();
  await page.keyboard.press("Enter");
}

test("J2: five inbox items are triaged by schedule, file and delete (with undo)", async ({
  page,
}) => {
  await ensureOwner(page);

  // Setup: a project to file into (the Projects UI arrives in MU-02) and the five captures.
  const project = await apiCall<{ id: string }>(page, "POST", "/api/projects", {
    name: "J2 Garden",
  });
  await page.goto("/inbox");
  for (const title of Object.values(titles)) {
    await page.getByLabel("Task title").fill(title);
    await page.getByRole("button", { name: "Add" }).click();
    await expect(
      page.getByRole("button", { name: `Open ${title}`, exact: true }),
    ).toBeVisible();
  }

  // 1. Schedule for today: one interaction.
  await press(page, `Schedule ${titles.today} for today`);
  await expect(
    page.getByRole("button", { name: `Open ${titles.today}` }),
  ).toBeHidden();

  // 2. Schedule for tomorrow: two interactions (the menu, then Tomorrow).
  await press(page, `Actions for ${titles.tomorrow}`);
  await pressItem(page, "Tomorrow");
  await expect(
    page.getByRole("button", { name: `Open ${titles.tomorrow}` }),
  ).toBeHidden();

  // 3. Pick a date: open the date picker, type the date and press Enter.
  const picked = dateIn(ZONE, 9);
  await press(page, `Pick a date for ${titles.picked}`);
  const dateDialog = page.getByRole("dialog", { name: `Pick a date for ${titles.picked}` });
  await dateDialog.getByLabel("Due date").fill(picked);
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("button", { name: `Open ${titles.picked}` }),
  ).toBeHidden();

  // 4. File to a project: open the project picker, choose the project.
  await press(page, `Move ${titles.filed} to a project`);
  await pressItem(page, "J2 Garden");
  await expect(
    page.getByRole("button", { name: `Open ${titles.filed}` }),
  ).toBeHidden();

  // 5. Delete (menu, Delete), undo, then delete again for good.
  await press(page, `Actions for ${titles.deleted}`);
  await pressItem(page, "Delete");
  await expect(
    page.getByRole("button", { name: `Open ${titles.deleted}` }),
  ).toBeHidden();
  await expect(page.getByRole("status")).toContainText(
    `Deleted “${titles.deleted}”`,
  );
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(
    page.getByRole("button", { name: `Open ${titles.deleted}` }),
  ).toBeVisible();
  await press(page, `Actions for ${titles.deleted}`);
  await pressItem(page, "Delete");
  await expect(
    page.getByRole("button", { name: `Open ${titles.deleted}` }),
  ).toBeHidden();

  // None of the five is left in the Inbox, even after a reload.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  for (const title of Object.values(titles)) {
    await expect(
      page.getByRole("button", { name: `Open ${title}` }),
    ).toBeHidden();
  }

  // Each landed where it was sent.
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: `Open ${titles.today}` }),
  ).toBeVisible();
  await page.goto("/upcoming");
  await expect(
    page.getByRole("button", { name: `Open ${titles.tomorrow}` }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: `Open ${titles.picked}` }),
  ).toBeVisible();

  const all = await apiCall<{
    tasks: { title: string; status: string; project_id: string | null }[];
  }>(page, "GET", "/api/tasks");
  const byTitle = new Map(all.tasks.map((task) => [task.title, task]));
  expect(byTitle.get(titles.filed)).toMatchObject({
    status: "next",
    project_id: project.id,
  });
  expect(byTitle.get(titles.today)).toMatchObject({ status: "next" });
  expect(byTitle.has(titles.deleted)).toBe(false);
});
