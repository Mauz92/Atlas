import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { apiCall, dateIn, ensureOwner } from "./helpers";

/**
 * MU-01 journey J2 — triage the inbox (docs/ROADMAP.md, MU): process five inbox items. Each can be
 * scheduled (today / tomorrow / pick a date), filed to a project, or deleted (with undo) in at most
 * two interactions, driven here from the keyboard (focus a control, press Enter). Real API and a
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

  // 2. Schedule for tomorrow: one interaction.
  await press(page, `Schedule ${titles.tomorrow} for tomorrow`);
  await expect(
    page.getByRole("button", { name: `Open ${titles.tomorrow}` }),
  ).toBeHidden();

  // 3. Pick a date: focus the date control and enter it.
  const picked = dateIn(ZONE, 9);
  await page.getByLabel(`Pick a date for ${titles.picked}`).fill(picked);
  await expect(
    page.getByRole("button", { name: `Open ${titles.picked}` }),
  ).toBeHidden();

  // 4. File to a project.
  await page
    .getByLabel(`File ${titles.filed} to a project`)
    .selectOption({ label: "J2 Garden" });
  await expect(
    page.getByRole("button", { name: `Open ${titles.filed}` }),
  ).toBeHidden();

  // 5. Delete, undo, then delete again for good.
  await press(page, `Delete ${titles.deleted}`);
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
  await press(page, `Delete ${titles.deleted}`);
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
