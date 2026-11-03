import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { apiCall, ensureOwner, openNoteDetails, searchButton } from "./helpers";

/**
 * MU-08 accessibility and layout sweep. Every main page is checked with axe-core (WCAG 2.x A/AA
 * rules, plus best practices) in both themes, and at phone (375px) and small-tablet (800px) widths
 * for horizontal overflow. Violations are fixed in the app, never suppressed here.
 */
const PAGES = [
  "/",
  "/inbox",
  "/upcoming",
  "/day",
  "/week",
  "/tasks",
  "/board",
  "/projects",
  "/calendar",
  "/sync",
  "/notifications",
  "/notes",
  "/search",
  "/settings",
];

async function seed(page: Page) {
  const project = await apiCall<{ id: string }>(page, "POST", "/api/projects", {
    name: "A11y project",
  });
  await apiCall(page, "POST", "/api/tasks", { title: "A11y inbox task" });
  await apiCall(page, "POST", "/api/tasks", {
    title: "A11y planned task",
    status: "next",
    project_id: project.id,
    due_at: `${new Date().toISOString().slice(0, 10)}T09:00:00`,
    time_zone: "UTC",
  });
  // An open note puts the editor, the preview with a task-list checkbox, the details panel and a
  // [[link]] on the page (the editor and the checkbox failed axe before UX-01).
  const note = await apiCall<{ id: string }>(page, "POST", "/api/notes", {
    path: "a11y/Note.md",
    content:
      "# A11y note\n\nSome text with a [link](https://example.com), a [[a11y/Note]] link and a [[a11y/missing]] one.\n\n- [ ] A11y checkbox item\n",
  });
  return { projectId: project.id, noteId: note.id };
}

async function settle(page: Page) {
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByText(/^Loading/)).toHaveCount(0);
  if (page.url().includes("/notes?open=")) {
    await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toBeVisible();
    // Preview and details panel on, so axe sees every part of the workspace (UX-05). On a phone the
    // preview replaces the editor, so the editor is only expected beside it on wider screens.
    const preview = page.getByRole("button", { name: "Preview", exact: true });
    if ((await preview.getAttribute("aria-pressed")) !== "true") await preview.click();
    await openNoteDetails(page);
    // In Live mode the editor holds a checkbox of its own (UX-06): this one is the preview's.
    await expect(
      page.getByTestId("markdown-preview").getByRole("checkbox", { name: "A11y checkbox item" }),
    ).toBeVisible();
    if ((page.viewportSize()?.width ?? 0) > 720) {
      await expect(page.getByRole("textbox", { name: "Note content" })).toBeVisible();
    }
  }
}

async function violations(page: Page) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"])
    .analyze();
  return result.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    nodes: v.nodes.map((n) => n.target.join(" ")).slice(0, 5),
  }));
}

test("axe finds no violations on the main pages in either theme, and no page overflows on a phone", async ({
  page,
}) => {
  // Two themes x every page plus the overlays (UX-04 added four panel states): ~30 s of axe runs.
  test.setTimeout(90_000);
  await ensureOwner(page);
  const { projectId, noteId } = await seed(page);
  // Collect every finding first so one run reports them all.
  const found: Record<string, unknown> = {};
  const check = async (label: string) => {
    const list = await violations(page);
    if (list.length > 0) found[label] = list;
  };
  const pages = [...PAGES, `/projects/${projectId}`, `/notes?open=${noteId}`];

  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.evaluate((value) => localStorage.setItem("atlas-theme", value), theme);
    for (const path of pages) {
      // The note is checked in both editor modes (UX-06): Source and Live render different DOM.
      const modes = path.startsWith("/notes?open=") ? (["source", "live"] as const) : ([null] as const);
      for (const mode of modes) {
        if (mode) await page.evaluate((value) => localStorage.setItem("atlas-notes-mode", value), mode);
        await page.goto(path);
        await settle(page);
        if (mode === "live") {
          await expect(page.locator(".cm-live-wikilink").first()).toBeVisible();
          await expect(page.locator(".cm-live-checkbox")).toHaveCount(1);
        }
        await check(`${path} (${mode ? `${mode}, ` : ""}${theme})`);
      }
    }
  }

  // Overlays: the task panel, the command palette and the shortcut help.
  await page.goto("/inbox");
  await page.getByRole("button", { name: "A11y inbox task" }).first().click();
  const details = page.getByRole("dialog", { name: "Task details" });
  await expect(details).toBeVisible();
  await check("task details");
  // UX-04 panel states: a property menu, the searchable time-zone list, the overlay below 1280 px.
  await details.getByRole("button", { name: /^Priority/ }).click();
  await expect(page.getByRole("menu", { name: "Priority" })).toBeVisible();
  await check("task details: priority menu");
  await page.keyboard.press("Escape");
  await details.getByRole("button", { name: /^Time zone/ }).click();
  await page.getByRole("combobox", { name: "Search time zones" }).fill("Stock");
  await check("task details: time zone list");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("combobox", { name: "Search time zones" })).toBeHidden();
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(details).toHaveAttribute("aria-modal", "true");
  await check("task details (overlay)");
  await page.keyboard.press("Escape");
  await expect(details).toBeHidden();
  await page.setViewportSize({ width: 1280, height: 720 });
  // UX-03: the shared row menu (a portal in the top layer) and its date dialog.
  await page.getByRole("button", { name: "Actions for A11y inbox task" }).click();
  await expect(page.getByRole("menu", { name: "Actions for A11y inbox task" })).toBeVisible();
  await check("task menu");
  await page.getByRole("menuitem", { name: "Pick a date…" }).click();
  await expect(page.getByRole("dialog", { name: "Pick a date for A11y inbox task" })).toBeVisible();
  await check("task date picker");
  await page.keyboard.press("Escape");
  await searchButton(page).click();
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
  await check("command palette");
  await page.keyboard.press("Escape");
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  await check("shortcut help");
  await page.keyboard.press("Escape");

  // UX-05 Notes states: the tree row menu, the header menu, an inline name box, and the details
  // panel as an overlay below 1440 px.
  await page.goto(`/notes?open=${noteId}`);
  await settle(page);
  await page.getByRole("button", { name: "Actions for A11y note" }).click();
  await expect(page.getByRole("menu", { name: "Actions for A11y note" })).toBeVisible();
  await check("notes: tree row menu");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Note options" }).click();
  await expect(page.getByRole("menu", { name: "Note options" })).toBeVisible();
  await check("notes: header menu");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "New folder" }).click();
  await expect(page.getByRole("textbox", { name: "New folder name" })).toBeVisible();
  await check("notes: inline name box");
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(page.getByRole("region", { name: "Note details" })).toBeVisible();
  await check("notes (1024, panel overlay)");
  await page.setViewportSize({ width: 1280, height: 720 });

  expect(found).toEqual({});

  // Layout: nothing may force sideways scrolling at phone and small-tablet widths.
  const wide: Record<string, number> = {};
  for (const width of [375, 800]) {
    await page.setViewportSize({ width, height: 800 });
    for (const path of pages) {
      await page.goto(path);
      await settle(page);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      if (overflow > 0) wide[`${path} at ${width}px`] = overflow;
    }
  }
  expect(wide, "pages that scroll sideways (px of overflow)").toEqual({});
});
