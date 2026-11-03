import { expect, test } from "./fixtures";
import { apiCall, ensureOwner, expectNoteSaved, noteMenu, openNoteDetails } from "./helpers";

/**
 * MU-06 journey J4 — write and link (docs/ROADMAP.md, MU): write a note, turn a line into a task,
 * link the note to a project. The task keeps a link back to the note, the note lists its tasks, and
 * its backlinks include tasks and projects. Real API and a fresh database.
 *
 * Also checks the Markdown rules: a checkbox line is not a task until the explicit action is used,
 * creating a task does not disturb the editor text, and a rename keeps the link. Since UX-05 the
 * note saves itself (no Save button) and Rename/Task from selection live in the "…" menu.
 */
interface TaskList {
  tasks: { id: string; title: string }[];
}
interface Note {
  id: string;
}

test("J4: [[ autocomplete, task from a line, project and backlinks, rename and unlink", async ({
  page,
}) => {
  await ensureOwner(page);
  const plan = await apiCall<Note>(page, "POST", "/api/notes", {
    path: "j4/garden-plan.md",
    content: "# Garden plan\n\n- [ ] J4 buy bulbs\n\nSee: ",
  });
  const seeds = await apiCall<Note>(page, "POST", "/api/notes", {
    path: "j4/seed-list.md",
    content: "# Seed list\n",
  });
  const project = await apiCall<{ id: string }>(page, "POST", "/api/projects", {
    name: "J4 Garden",
  });
  await apiCall(page, "PUT", `/api/projects/${project.id}/notes/${plan.id}`);

  // A checkbox in Markdown is just text: no task exists yet.
  const tasksMatching = () => apiCall<TaskList>(page, "GET", "/api/tasks?q=J4%20buy%20bulbs");
  expect((await tasksMatching()).tasks).toHaveLength(0);

  await page.goto(`/notes?open=${plan.id}`);
  await expect(page.getByTitle("Revision 1").filter({ hasText: "j4/garden-plan.md" })).toBeVisible();
  await openNoteDetails(page);
  await expect(page.getByRole("list", { name: "Linked projects" }).getByRole("link", { name: "J4 Garden" })).toBeVisible();

  // `[[` offers notes; accepting one inserts its path and the closing brackets.
  const editor = page.getByTestId("note-editor").locator(".cm-content");
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("[[seed");
  const option = page.getByRole("option", { name: /j4\/seed-list/ });
  await expect(option).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(editor).toContainText("See: [[j4/seed-list]]");

  // Task from the line under the cursor (nothing selected): the title is the cleaned line, and a
  // too-long title is refused with the server's own message.
  await editor.locator(".cm-line", { hasText: "J4 buy bulbs" }).click();
  await noteMenu(page, "Task from selection");
  const form = page.getByRole("form", { name: "New task from note" });
  await expect(form.getByLabel("Task title")).toHaveValue("J4 buy bulbs");
  await expect(form).toContainText("Will be filed in “J4 Garden”");
  await form.getByLabel("Task title").fill("x".repeat(513));
  await form.getByRole("button", { name: "Create task" }).click();
  await expect(form.getByRole("alert")).toContainText("at most 512 characters");
  expect((await apiCall<TaskList>(page, "GET", "/api/tasks?q=xxxxxxxxxx")).tasks).toHaveLength(0);
  await form.getByLabel("Task title").fill("J4 buy bulbs");
  await form.getByRole("button", { name: "Create task" }).click();
  await expect(form).toBeHidden();

  // The note lists the task and the project; the text was left alone; one task exists.
  const linkedTasks = page.getByRole("list", { name: "Linked tasks" });
  await expect(linkedTasks.getByRole("button", { name: "J4 buy bulbs" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Linked projects" })).toBeVisible();
  // The cursor left the line, so Live mode shows the link rendered; the text itself is checked below.
  await expect(editor).toContainText("See: j4/seed-list");
  const created = (await tasksMatching()).tasks;
  expect(created).toHaveLength(1);
  const taskDetail = await apiCall<{ project_id: string }>(page, "GET", `/api/tasks/${created[0].id}`);
  expect(taskDetail.project_id).toBe(project.id);

  // Autosave writes the link text without any click; the target note now has the plan as a backlink.
  await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  await expectNoteSaved(page);
  expect((await apiCall<{ content: string }>(page, "GET", `/api/notes/${plan.id}`)).content).toContain(
    "See: [[j4/seed-list]]",
  );
  await page.goto(`/notes?open=${seeds.id}`);
  await expect(
    page.getByRole("list", { name: "Linked notes" }).getByRole("button", { name: "j4/garden-plan.md" }),
  ).toBeVisible();

  // Back in the plan, open the task: its detail lists the note it came from.
  await page.goto(`/notes?open=${plan.id}`);
  await page.getByRole("list", { name: "Linked tasks" }).getByRole("button", { name: "J4 buy bulbs" }).click();
  const detail = page.getByRole("dialog", { name: "Task details" });
  await expect(detail.getByLabel("Title")).toHaveValue("J4 buy bulbs");
  await expect(detail.getByRole("button", { name: "Open note j4/garden-plan.md" })).toBeVisible();
  await page.keyboard.press("Escape");

  // Rename the note in the header (no prompt): the link follows (it holds the note's id, not its path).
  await noteMenu(page, "Rename");
  await page.getByRole("textbox", { name: "Note name" }).fill("garden-plan-renamed");
  await page.keyboard.press("Enter");
  await expect(page.getByTitle(/^Revision \d+$/).filter({ hasText: "j4/garden-plan-renamed.md" })).toBeVisible();
  await page.getByRole("list", { name: "Linked tasks" }).getByRole("button", { name: "J4 buy bulbs" }).click();
  await expect(detail.getByRole("button", { name: "Open note j4/garden-plan-renamed.md" })).toBeVisible();

  // From the task, jump to the note; then unlink from the task.
  await detail.getByRole("button", { name: "Open note j4/garden-plan-renamed.md" }).click();
  await expect(page).toHaveURL(new RegExp(`/notes\\?open=${plan.id}`));
  await expect(detail).toBeHidden();
  await page.getByRole("list", { name: "Linked tasks" }).getByRole("button", { name: "J4 buy bulbs" }).click();
  await detail.getByRole("button", { name: "Unlink note j4/garden-plan-renamed.md" }).click();
  await expect(detail.getByText(/No linked notes/)).toBeVisible();
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(page.getByTitle(/^Revision \d+$/).filter({ hasText: "j4/garden-plan-renamed.md" })).toBeVisible();
  await openNoteDetails(page);
  await expect(page.getByRole("list", { name: "Linked tasks" })).toHaveCount(0);
  await expect(page.getByRole("list", { name: "Linked projects" })).toBeVisible();
});
