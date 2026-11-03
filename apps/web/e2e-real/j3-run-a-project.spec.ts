import { expect, test } from "./fixtures";
import { apiCall, chooseTaskProperty, ensureOwner, expectTaskSaved } from "./helpers";

/**
 * MU-02 journey J3 — run a project (docs/ROADMAP.md, MU): create a project in the UI, add tasks,
 * file an inbox task into it from the task detail, complete one and move another on the project's
 * board, link a note, edit, archive and restore it. Real API, fresh database, no API set-up beyond
 * creating the note that gets linked (the notes UI is not under test here).
 */
test("J3: create a project, run its tasks on the list and board, link a note, archive and restore", async ({
  page,
}) => {
  await ensureOwner(page);
  await apiCall(page, "POST", "/api/notes", {
    path: "j3/orchard-plan.md",
    content: "# Orchard plan\n",
  });

  // Create it from the Projects page.
  await page.goto("/projects");
  await page.getByText("New project", { exact: true }).click();
  await page.getByLabel("Project name").fill("J3 Orchard");
  await page.getByLabel("Project description").fill("Plant twelve trees");
  await page.getByRole("button", { name: "Create project" }).click();
  const sidebar = page.getByRole("list", { name: "Active projects" });
  await expect(sidebar.getByRole("link", { name: "J3 Orchard" })).toBeVisible();

  // An inbox task is filed into it from the task detail.
  await page.goto("/inbox");
  await page.getByLabel("Task title").fill("J3 buy saplings");
  await page.getByRole("button", { name: "Add" }).click();
  await page.getByRole("button", { name: "Open J3 buy saplings" }).click();
  // UX-04: choosing the project saves it; wait for the panel's "Saved" indicator.
  await chooseTaskProperty(page, "Project", "J3 Orchard");
  await expectTaskSaved(page);
  await page.keyboard.press("Escape");

  // The project page: description, an empty-then-filling task list, derived progress.
  await sidebar.getByRole("link", { name: "J3 Orchard" }).click();
  await expect(page.getByRole("heading", { name: "J3 Orchard" })).toBeVisible();
  await expect(page.getByText("Plant twelve trees")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open J3 buy saplings" })).toBeVisible();
  for (const title of ["J3 dig holes", "J3 water"]) {
    await page.getByLabel("Task title").fill(title);
    await page.getByRole("button", { name: "Add" }).click();
    await expect(page.getByRole("button", { name: `Open ${title}` })).toBeVisible();
  }
  await expect(page.getByText("0/3 done · 0%")).toBeVisible();

  // UX-03: the "Complete" button is now a round checkbox with the same accessible name.
  await page.getByRole("checkbox", { name: "Complete J3 buy saplings" }).click();
  await expect(page.getByText("1/3 done · 33%")).toBeVisible();

  // The board: move a task with its card menu ("Move to…"), and it survives a reload.
  const inProgress = page.getByRole("region", { name: "In progress" });
  await page.getByRole("button", { name: "Board", exact: true }).click();
  await page.getByRole("button", { name: "Actions for J3 dig holes" }).click();
  await page.getByRole("menuitem", { name: "Move to…" }).click();
  await page.getByRole("menuitemradio", { name: "In progress" }).click();
  await expect(inProgress.getByRole("button", { name: "Open J3 dig holes" })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Board", exact: true }).click();
  await expect(inProgress.getByRole("button", { name: "Open J3 dig holes" })).toBeVisible();

  // Linked notes persist.
  await page.getByLabel("Link a note").selectOption({ label: "j3/orchard-plan.md" });
  await expect(page.getByRole("button", { name: "Unlink j3/orchard-plan.md" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Unlink j3/orchard-plan.md" })).toBeVisible();

  // Edit, archive (leaves the sidebar), restore (returns).
  await page.getByRole("button", { name: "Edit project" }).click();
  await page.getByLabel("Project name").fill("J3 Orchard 2");
  await page.getByRole("button", { name: "Save project" }).click();
  await expect(page.getByRole("heading", { name: "J3 Orchard 2" })).toBeVisible();
  await page.getByRole("button", { name: "Archive project" }).click();
  await expect(sidebar.getByRole("link", { name: "J3 Orchard 2" })).toBeHidden();
  await page.goto("/projects");
  await expect(page.getByRole("heading", { name: "Archived" })).toBeVisible();
  await page.getByRole("button", { name: "Restore J3 Orchard 2" }).click();
  await expect(sidebar.getByRole("link", { name: "J3 Orchard 2" })).toBeVisible();
  await expect(page.getByText("1/3 done · 33%")).toBeVisible();
});
