import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";
import path from "node:path";

import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { ensureOwner, openSettingsSection, searchButton } from "./helpers";

/**
 * UX-08 — Settings consolidation, skeletons and empty states (docs/ROADMAP.md, UX; ADR-0058). The
 * things only a real browser can show: the two-column Settings with a section in the URL, the
 * phone drill-in, redirects and palette entries for the pages that became sections, a skeleton
 * (not "Loading…" text) while a list loads without moving the page, the shared empty state, and
 * axe plus no sideways scrolling at four widths in both themes. Real API and a fresh database;
 * empty lists are produced by answering the list request with an empty list, because the
 * journeys share one database. Screenshots go to $ATLAS_SHOT_DIR when it is set.
 */
test.use({ viewport: { width: 1440, height: 900 } });

const SECTIONS = [
  ["account", "Account"],
  ["appearance", "Appearance"],
  ["notifications", "Notifications and reminders"],
  ["calendar", "Calendar"],
  ["sync", "Sync"],
  ["data", "Data and backups"],
  ["about", "About"],
] as const;

const WIDTHS = [1440, 1024, 720, 390];

async function axeFindings(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"])
    .analyze();
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

const overflowOf = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** Hold every request matching `pattern` until the returned function is called. */
async function hold(page: Page, pattern: RegExp) {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const handler = async (route: import("@playwright/test").Route) => {
    await gate;
    await route.continue().catch(() => undefined);
  };
  await page.route(pattern, handler);
  return async () => {
    open();
    await page.unroute(pattern, handler);
  };
}

const shotDir = () => {
  const dir = process.env.ATLAS_SHOT_DIR;
  if (dir) mkdirSync(dir, { recursive: true });
  return dir;
};

test("Settings: one section at a time, in the URL, with redirects and palette entries", async ({ page }) => {
  await ensureOwner(page);

  // Every section opens from the list, is in the URL and survives a reload.
  await page.goto("/settings");
  const list = page.getByRole("navigation", { name: "Settings sections" });
  await expect(page.getByRole("heading", { name: "Account", level: 2 })).toBeVisible();
  for (const [id, label] of SECTIONS) {
    await openSettingsSection(page, label);
    await expect(page).toHaveURL(new RegExp(`/settings/${id}$`));
    await expect(list.getByRole("link", { name: label, exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.locator("#settings-section-title")).toHaveText(label);
    expect(await page.locator("button.primary").count(), `${label}: primary buttons`).toBeLessThanOrEqual(1);
  }
  await page.reload();
  await expect(page.getByRole("heading", { name: "About", level: 2 })).toBeVisible();
  await expect(page.getByRole("region", { name: "Instance" })).toBeVisible();

  // Deep links and the pages that became sections.
  for (const [from, to, heading] of [
    ["/sync", "/settings/sync", "Sync"],
    ["/notifications", "/settings/notifications", "Notifications and reminders"],
    ["/calendar", "/settings/calendar", "Calendar"],
    ["/settings/nope", "/settings", "Account"],
  ]) {
    await page.goto(from);
    await expect(page).toHaveURL(new RegExp(`${to}$`));
    await expect(page.getByRole("heading", { name: heading, level: 2, exact: true })).toBeVisible();
  }

  // The palette still goes to each of them.
  for (const [query, to] of [
    ["Go to Sync", "/settings/sync"],
    ["Go to Calendar", "/settings/calendar"],
    ["Go to Notifications", "/settings/notifications"],
  ]) {
    await page.goto("/");
    await searchButton(page).click();
    await page.getByRole("dialog", { name: "Command palette" }).getByRole("combobox").fill(query);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`${to}$`));
  }

  // The old pages' content still works inside the sections.
  await page.goto("/settings/sync");
  await expect(page.locator(".sync-panel")).toBeVisible();
  await expect(page.getByText("All synced")).toBeVisible();
  await page.goto("/settings/calendar");
  await expect(page.getByText(/No calendar accounts are connected yet|Google Calendar/)).toBeVisible();

  // Phone: the list first, then one section with a way back.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings");
  await expect(list).toBeVisible();
  await expect(page.getByLabel("Display name")).toBeHidden();
  await list.getByRole("link", { name: "Sync", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/sync$/);
  await expect(page.getByRole("heading", { name: "Sync", level: 2 })).toBeVisible();
  await expect(list).toBeHidden();
  await page.getByRole("link", { name: "All settings" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(list).toBeVisible();
  await expect(page.getByRole("heading", { name: "Account", level: 2 })).toBeHidden();
});

test("Settings: axe clean and no sideways scrolling in every section, four widths, both themes", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await ensureOwner(page);
  const shots = shotDir();
  const found: Record<string, string[]> = {};
  const wide: Record<string, number> = {};
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.evaluate((value) => localStorage.setItem("atlas-theme", value), theme);
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      const targets: [string, string][] = [["index", "/settings"], ...SECTIONS.map(([id]) => [id, `/settings/${id}`] as [string, string])];
      for (const [name, url] of targets) {
        await page.goto(url);
        await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
        await expect(page.getByText(/^Loading/)).toHaveCount(0);
        const label = `${name} ${theme} ${width}px`;
        const list = await axeFindings(page);
        if (list.length) found[label] = list;
        const overflow = await overflowOf(page);
        if (overflow > 0) wide[label] = overflow;
        const wanted = ["index", "account", "appearance", "sync", "data"].includes(name);
        if (shots && wanted && (width === 1440 || width === 390)) {
          await page.screenshot({ path: path.join(shots, `settings-${name}-${theme}-${width}.png`) });
        }
      }
    }
  }
  expect(found).toEqual({});
  expect(wide, "pages that scroll sideways (px of overflow)").toEqual({});
});

test("loading shows a skeleton that holds the page still, then data replaces it", async ({ page }) => {
  test.setTimeout(120_000);
  await ensureOwner(page);
  const shots = shotDir();
  const lists: [string, string, RegExp, string][] = [
    ["inbox", "/inbox", /\/api\/tasks(\?|$)/, "Loading inbox"],
    ["tasks", "/tasks", /\/api\/tasks(\?|$)/, "Loading tasks"],
    ["today", "/", /\/api\/tasks(\?|$)/, "Loading today"],
    ["upcoming", "/upcoming", /\/api\/tasks(\?|$)/, "Loading upcoming"],
    ["week", "/week", /\/api\/tasks(\?|$)/, "Loading the week"],
    ["projects", "/projects", /\/api\/projects(\?|$)/, "Loading projects"],
    ["notes", "/notes", /\/api\/notes(\?|$)/, "Loading notes"],
  ];
  for (const [name, url, pattern, label] of lists) {
    const release = await hold(page, pattern);
    await page.goto(url, { waitUntil: "commit" });
    const status = page.getByRole("status").filter({ hasText: label });
    await expect(status, `${name}: skeleton`).toBeVisible();
    const heading = page.getByRole("heading", { level: 1 }).first();
    const before = await heading.boundingBox();
    if (name === "inbox" && shots) {
      for (const theme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: theme });
        await page.screenshot({ path: path.join(shots, `skeleton-inbox-${theme}-1440.png`) });
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: path.join(shots, "skeleton-inbox-light-390.png") });
      await page.setViewportSize({ width: 1440, height: 900 });
    }
    await release();
    await expect(page.getByRole("status").filter({ hasText: label }), `${name}: skeleton gone`).toHaveCount(0);
    const after = await heading.boundingBox();
    expect(after?.y, `${name}: the heading did not move`).toBe(before?.y);
  }
});

test("the skeleton is axe clean and fits four widths in both themes", async ({ page }) => {
  test.setTimeout(120_000);
  await ensureOwner(page);
  const found: Record<string, string[]> = {};
  const wide: Record<string, number> = {};
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.evaluate((value) => localStorage.setItem("atlas-theme", value), theme);
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      for (const [url, pattern, label] of [
        ["/inbox", /\/api\/tasks(\?|$)/, "Loading inbox"],
        ["/board", /\/api\/tasks(\?|$)/, "Loading board"],
        ["/projects", /\/api\/projects(\?|$)/, "Loading projects"],
      ] as [string, RegExp, string][]) {
        const release = await hold(page, pattern);
        await page.goto(url, { waitUntil: "commit" });
        await expect(page.getByRole("status").filter({ hasText: label })).toBeVisible();
        const key = `${url} ${theme} ${width}px`;
        const list = await axeFindings(page);
        if (list.length) found[key] = list;
        const overflow = await overflowOf(page);
        if (overflow > 0) wide[key] = overflow;
        await release();
      }
    }
  }
  expect(found).toEqual({});
  expect(wide, "pages that scroll sideways (px of overflow)").toEqual({});
});

test("every empty list has an icon and a sentence; Tasks tells 'no results' from 'none yet'", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await ensureOwner(page);
  const shots = shotDir();
  const emptyTasks = { tasks: [] };
  await page.route(/\/api\/tasks(\?|$)/, (route) =>
    route.request().method() === "GET" ? route.fulfill({ json: emptyTasks }) : route.continue(),
  );
  await page.route(/\/api\/projects(\?|$)/, (route) =>
    route.request().method() === "GET" ? route.fulfill({ json: { projects: [] } }) : route.continue(),
  );
  await page.route(/\/api\/notes(\?|$)/, (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: { notes: [], folders: [] } })
      : route.continue(),
  );

  const pages: [string, string, RegExp][] = [
    ["inbox", "/inbox", /Inbox zero/],
    ["today", "/", /Nothing is due today/],
    ["upcoming", "/upcoming", /Nothing is scheduled/],
    ["week", "/week", /Nothing planned for this week/],
    ["projects", "/projects", /No projects yet/],
    ["tasks", "/tasks", /No open tasks/],
    ["tasks-filtered", "/tasks?q=zzzz", /No tasks match these filters/],
    ["notes", "/notes", /No notes yet|Select a note, or create one/],
  ];
  const found: Record<string, string[]> = {};
  const wide: Record<string, number> = {};
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.evaluate((value) => localStorage.setItem("atlas-theme", value), theme);
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      for (const [name, url, text] of pages) {
        await page.goto(url);
        const empty = page.locator(".empty-state:visible").filter({ hasText: text });
        await expect(empty.first(), `${name}: empty state`).toBeVisible();
        await expect(empty.first().locator("svg.icon")).toHaveCount(1);
        const key = `${name} ${theme} ${width}px`;
        const list = await axeFindings(page);
        if (list.length) found[key] = list;
        const overflow = await overflowOf(page);
        if (overflow > 0) wide[key] = overflow;
        if (shots && (width === 1440 || width === 390)) {
          await page.screenshot({ path: path.join(shots, `empty-${name}-${theme}-${width}.png`) });
        }
      }
    }
  }
  expect(found).toEqual({});
  expect(wide, "pages that scroll sideways (px of overflow)").toEqual({});

  // "None yet" points at the Inbox; "no results" has no action of its own (the bar has Reset filters).
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/tasks");
  await page.getByRole("button", { name: "Go to Inbox" }).click();
  await expect(page).toHaveURL(/\/inbox$/);
  await page.goto("/tasks?q=zzzz");
  await expect(page.getByText(/No tasks match these filters/)).toBeVisible();
  await expect(page.locator(".empty-state").getByRole("button")).toHaveCount(0);
  await page.getByRole("button", { name: "Reset filters" }).click();
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(page.getByText(/No open tasks/)).toBeVisible();
});

test("sign-in and first-run pages are one centred card in the design system", async ({ page, browser }) => {
  test.setTimeout(120_000);
  await ensureOwner(page); // the owner exists, so a signed-out visitor sees the sign-in page
  const shots = shotDir();
  const anonymous = await browser.newContext({ baseURL: process.env.ATLAS_E2E_BASE_URL, viewport: { width: 1440, height: 900 } });
  const visitor = await anonymous.newPage();
  const found: Record<string, string[]> = {};
  const wide: Record<string, number> = {};
  try {
    for (const [name, heading, mockSetup] of [
      ["login", "Sign in to Atlas", false],
      ["setup", "Create your Atlas account", true],
    ] as [string, string, boolean][]) {
      // First-run needs an instance without an owner: answer the status request for this page only.
      if (mockSetup) {
        await visitor.route(/\/api\/setup\/status$/, (route) => route.fulfill({ json: { setup_required: true } }));
      }
      for (const theme of ["light", "dark"] as const) {
        await visitor.emulateMedia({ colorScheme: theme });
        for (const width of WIDTHS) {
          await visitor.setViewportSize({ width, height: 900 });
          await visitor.goto("/");
          await expect(visitor.getByRole("heading", { name: heading })).toBeVisible();
          const card = visitor.locator("form.card");
          const box = await card.boundingBox();
          // Centred horizontally within a tolerance of a pixel.
          expect(Math.abs((box?.x ?? 0) * 2 + (box?.width ?? 0) - width), `${name} ${width}px centred`).toBeLessThanOrEqual(1);
          const key = `${name} ${theme} ${width}px`;
          const list = await axeFindings(visitor);
          if (list.length) found[key] = list;
          const overflow = await overflowOf(visitor);
          if (overflow > 0) wide[key] = overflow;
          if (shots && (width === 1440 || width === 390)) {
            await visitor.screenshot({ path: path.join(shots, `auth-${name}-${theme}-${width}.png`) });
          }
        }
      }
    }
  } finally {
    await anonymous.close();
  }
  expect(found).toEqual({});
  expect(wide, "pages that scroll sideways (px of overflow)").toEqual({});
});

test("a long sidebar scrolls on its own and the account row stays in view", async ({ page }) => {
  await ensureOwner(page);
  await page.setViewportSize({ width: 1440, height: 420 });
  await page.goto("/");
  const footer = page.locator(".sidebar-footer");
  await expect(footer).toBeVisible();
  const box = await footer.boundingBox();
  expect(box).not.toBeNull();
  // The status bar is 24px; the footer must end above the bottom edge of the window.
  expect(box!.y + box!.height).toBeLessThanOrEqual(420);
  const nav = page.locator(".sidebar-nav");
  expect(await nav.evaluate((el) => getComputedStyle(el).overflowY)).toBe("auto");
});
