import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import {
  apiCall,
  chooseTaskProperty,
  dateIn,
  ensureOwner,
  expectTaskSaved,
  taskPanel,
  taskProperty,
} from "./helpers";

/**
 * UX-04 — the task detail as a property panel that saves itself (ADR-0053). Real API, fresh
 * database. Every check of persistence reads the server (a reload or the API), never the panel's
 * own state.
 */
const ZONE = "Europe/Stockholm";
test.use({ timezoneId: ZONE, locale: "en-GB", viewport: { width: 1440, height: 900 } });

interface ApiTask {
  id: string;
  title: string;
  description: string | null;
  priority: string;
  due_at: string | null;
  tags: string[];
  revision: number;
}

async function create(page: Page, title: string): Promise<ApiTask> {
  return apiCall<ApiTask>(page, "POST", "/api/tasks", { title, status: "next" });
}

const read = (page: Page, id: string) => apiCall<ApiTask>(page, "GET", `/api/tasks/${id}`);

async function openOnTasks(page: Page, title: string) {
  await page.goto(`/tasks?q=${encodeURIComponent(title)}`);
  await page.getByRole("button", { name: `Open ${title}`, exact: true }).click();
  await expect(taskPanel(page).getByLabel("Title")).toHaveValue(title);
}

/** Counts PATCHes to the task API that overlap in time. */
function watchPatches(page: Page) {
  let inFlight = 0;
  const stats = { max: 0, total: 0 };
  const isPatch = (url: string, method: string) => method === "PATCH" && /\/api\/tasks\/[^/]+$/.test(url);
  page.on("request", (request) => {
    if (!isPatch(request.url(), request.method())) return;
    inFlight += 1;
    stats.total += 1;
    stats.max = Math.max(stats.max, inFlight);
  });
  const done = (request: { url(): string; method(): string }) => {
    if (isPatch(request.url(), request.method())) inFlight -= 1;
  };
  page.on("requestfinished", done);
  page.on("requestfailed", done);
  return stats;
}

test("every property saves by itself and survives a reload; docked panel keeps the list", async ({
  page,
}) => {
  await ensureOwner(page);
  const title = "UX4 plan the picnic";
  const task = await create(page, title);
  await create(page, "UX4 neighbour row");
  const patches = watchPatches(page);
  await page.goto("/tasks?q=UX4");
  const row = page.getByRole("button", { name: `Open ${title}`, exact: true });
  await row.click();
  const panel = taskPanel(page);

  // No Save button; the indicator is in view at 900 px height; the list stays visible beside it.
  await expect(panel.getByRole("button", { name: /^Save/ })).toHaveCount(0);
  const indicator = panel.locator("[data-save-state]");
  await expect(indicator).toBeInViewport();
  const panelBox = (await panel.boundingBox())!;
  const rowBox = (await page.getByRole("button", { name: "Open UX4 neighbour row" }).boundingBox())!;
  expect(rowBox.x + rowBox.width).toBeLessThanOrEqual(panelBox.x);
  await expect(panel).not.toHaveAttribute("aria-modal", "true");

  await panel.getByLabel("Title").fill(`${title} by the lake`);
  await chooseTaskProperty(page, "Priority", "High");
  await panel.getByLabel("Due date", { exact: true }).fill(dateIn(ZONE, 4));
  await panel.getByLabel("Add a tag").fill("outdoors, Food");
  await panel.getByLabel("Add a tag").press("Enter");
  await panel.getByLabel("Description").pressSequentially("Bring the blanket and a ball", { delay: 15 });
  await panel.getByLabel("Description").blur();
  await expectTaskSaved(page);
  expect(patches.max).toBe(1);

  // Esc closes and focus returns to the row that opened the panel.
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(page.getByRole("button", { name: `Open ${title} by the lake`, exact: true })).toBeFocused();

  await page.reload();
  await page.getByRole("button", { name: `Open ${title} by the lake`, exact: true }).click();
  await expect(panel.getByLabel("Title")).toHaveValue(`${title} by the lake`);
  await expect(taskProperty(page, "Priority")).toContainText("High");
  await expect(panel.getByLabel("Due date", { exact: true })).toHaveValue(dateIn(ZONE, 4));
  await expect(panel.getByRole("list", { name: "Tags" }).getByRole("listitem")).toHaveText([
    "#Food",
    "#outdoors",
  ]);
  await expect(panel.getByLabel("Description")).toHaveValue("Bring the blanket and a ball");
  const saved = await read(page, task.id);
  expect(saved).toMatchObject({ priority: "high", description: "Bring the blanket and a ball" });
});

test("a stale edit in a second tab shows the conflict and overwrites nothing", async ({
  page,
  context,
}) => {
  await ensureOwner(page);
  const title = "UX4 stale edit";
  const task = await create(page, title);
  await openOnTasks(page, title);
  const other = await context.newPage();
  await openOnTasks(other, title);

  // The first tab saves a new title...
  await taskPanel(page).getByLabel("Title").fill(`${title} (first tab)`);
  await taskPanel(page).getByLabel("Title").press("Enter");
  await expectTaskSaved(page);

  // ...the second, still on the old revision, edits the description and gets a conflict.
  await taskPanel(other).getByLabel("Description").fill("Second tab's note");
  await taskPanel(other).getByLabel("Description").blur();
  await expect(taskPanel(other).getByText(/changed somewhere else/i)).toBeVisible();
  await expect(taskPanel(other).locator("[data-save-state]")).toHaveText("Conflict");
  await expect(taskPanel(other).getByLabel("Description")).toHaveValue("Second tab's note");
  const server = await read(page, task.id);
  expect(server).toMatchObject({ title: `${title} (first tab)`, description: null });

  // Load latest shows the first tab's title and sets the unsaved note aside, offered for reapplying.
  await taskPanel(other).getByRole("button", { name: "Load latest version" }).click();
  await expect(taskPanel(other).getByLabel("Title")).toHaveValue(`${title} (first tab)`);
  await expect(taskPanel(other).getByText(/set aside: description/)).toBeVisible();
  await taskPanel(other).getByRole("button", { name: "Reapply my changes" }).click();
  await expectTaskSaved(other);
  expect(await read(page, task.id)).toMatchObject({
    title: `${title} (first tab)`,
    description: "Second tab's note",
  });
  await other.close();
});

test("rapid typing then an immediate close persists the text; switching and deleting keep edits", async ({
  page,
}) => {
  await ensureOwner(page);
  const first = await create(page, "UX4 rapid alpha");
  const second = await create(page, "UX4 rapid beta");
  const patches = watchPatches(page);
  await page.goto("/tasks?q=UX4%20rapid");
  await page.getByRole("button", { name: "Open UX4 rapid alpha", exact: true }).click();
  const panel = taskPanel(page);

  // Type fast and close at once (well inside the debounce): the close flushes first.
  await panel.getByLabel("Description").click();
  await page.keyboard.type("typed fast and closed at once", { delay: 0 });
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  expect((await read(page, first.id)).description).toBe("typed fast and closed at once");

  // Switching to another row while text is pending saves it before the switch.
  await page.getByRole("button", { name: "Open UX4 rapid alpha", exact: true }).click();
  await panel.getByLabel("Title").fill("UX4 rapid alpha renamed");
  await page.getByRole("button", { name: "Open UX4 rapid beta", exact: true }).click();
  await expect(panel.getByLabel("Title")).toHaveValue("UX4 rapid beta");
  expect((await read(page, first.id)).title).toBe("UX4 rapid alpha renamed");

  // Delete while a save is pending: the edit is saved first, so undo brings it back.
  await panel.getByLabel("Title").fill("UX4 rapid beta last words");
  await panel.getByRole("button", { name: "Task options" }).click();
  await page.getByRole("menuitem", { name: "Delete task" }).click();
  await expect(panel).toBeHidden();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  // The delete itself carried the saved edit: the restored task has it.
  await expect
    .poll(async () => (await read(page, second.id).catch(() => null))?.title ?? "(deleted)")
    .toBe("UX4 rapid beta last words");
  expect(patches.max).toBe(1);
});

test("a server validation message is shown verbatim on its field and the text is kept", async ({
  page,
}) => {
  await ensureOwner(page);
  const title = "UX4 validate";
  const task = await create(page, title);
  await openOnTasks(page, title);
  const panel = taskPanel(page);
  await panel.getByLabel("Title").fill("");
  await panel.getByLabel("Title").blur();
  await expect(panel.getByRole("alert")).toHaveText("title: String should have at least 1 character");
  await expect(panel.getByLabel("Title")).toHaveValue("");
  await expect(panel.locator("[data-save-state]")).toHaveText("Not saved");
  expect((await read(page, task.id)).title).toBe(title);

  // Closing with the rejected edit asks first instead of dropping it silently.
  await page.keyboard.press("Escape");
  await expect(panel.getByText(/not saved yet: Title/)).toBeVisible();
  await panel.getByRole("button", { name: "Keep editing" }).click();
  await panel.getByLabel("Title").fill(`${title} fixed`);
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  expect((await read(page, task.id)).title).toBe(`${title} fixed`);
});
