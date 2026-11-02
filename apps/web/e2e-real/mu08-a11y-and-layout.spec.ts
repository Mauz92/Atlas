import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { apiCall, ensureOwner } from "./helpers";

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
  await apiCall(page, "POST", "/api/notes", {
    path: "a11y/Note.md",
    content: "# A11y note\n\nSome text with a [link](https://example.com).\n",
  });
  return project.id;
}

async function settle(page: Page) {
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByText(/^Loading/)).toHaveCount(0);
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
  await ensureOwner(page);
  const projectId = await seed(page);
  // Collect every finding first so one run reports them all.
  const found: Record<string, unknown> = {};
  const check = async (label: string) => {
    const list = await violations(page);
    if (list.length > 0) found[label] = list;
  };
  const pages = [...PAGES, `/projects/${projectId}`];

  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.evaluate((value) => localStorage.setItem("atlas-theme", value), theme);
    for (const path of pages) {
      await page.goto(path);
      await settle(page);
      await check(`${path} (${theme})`);
    }
  }

  // Overlays: the task panel, the command palette and the shortcut help.
  await page.goto("/inbox");
  await page.getByRole("button", { name: "A11y inbox task" }).first().click();
  await expect(page.getByRole("dialog", { name: "Task details" })).toBeVisible();
  await check("task details");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /Search · Ctrl K/ }).click();
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
  await check("command palette");
  await page.keyboard.press("Escape");
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  await check("shortcut help");
  await page.keyboard.press("Escape");

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
