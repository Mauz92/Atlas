import AxeBuilder from "@axe-core/playwright";
import type { Browser, BrowserContext, Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { apiCall, dateIn, ensureOwner, taskPanel } from "./helpers";

/**
 * UX-09 — readability tokens, the task row anatomy and the section structure (ADR-0062).
 * Measured in a real browser at 360, 390, 768 and 1440 px in both themes: no horizontal scroll,
 * axe clean, rows of at most three lines (and 96 px) on a phone, 44 px targets on touch, a 16 px
 * title, sticky section headers, overdue conveyed in words. Real API and a fresh database.
 */
const ZONE = "Europe/Stockholm";
test.use({ timezoneId: ZONE, locale: "en-GB" });

const SIZES = [
  { name: "360", width: 360, height: 740, touch: true },
  { name: "390", width: 390, height: 844, touch: true },
  { name: "768", width: 768, height: 1024, touch: true },
  { name: "1440", width: 1440, height: 900, touch: false },
] as const;
const PAGES = ["/", "/inbox", "/upcoming", "/week", "/tasks", "/projects"];
const LONG_TITLE =
  "UX9 review and finalise the quarterly budget spreadsheet together with the accountant before the board meeting on Friday morning";

async function seed(page: Page) {
  await ensureOwner(page);
  const project = await apiCall<{ id: string }>(page, "POST", "/api/projects", { name: "UX9 Website relaunch" });
  const parent = await apiCall<{ id: string }>(page, "POST", "/api/tasks", {
    title: "UX9 draft talk outline",
    status: "next",
    priority: "high",
    project_id: project.id,
    due_at: `${dateIn(ZONE, 0)}T23:59:00`,
    time_zone: ZONE,
  });
  await apiCall(page, "POST", "/api/tasks", { title: "UX9 slides", parent_task_id: parent.id });
  // Overdue, urgent, long title, three tags, a project: the worst case for a phone row.
  await apiCall(page, "POST", "/api/tasks", {
    title: LONG_TITLE,
    status: "next",
    priority: "urgent",
    project_id: project.id,
    tags: ["finance", "quarterly-review", "work"],
    due_at: `${dateIn(ZONE, -5)}T09:00:00`,
    time_zone: ZONE,
  });
  await apiCall(page, "POST", "/api/tasks", {
    title: "UX9 call the plumber",
    status: "next",
    due_at: `${dateIn(ZONE, 1)}T10:30:00`,
    time_zone: ZONE,
    tags: ["home", "calls", "quotes", "urgent-ish"],
    project_id: project.id,
  });
  await apiCall(page, "POST", "/api/tasks", { title: "UX9 later this week", status: "next", due_at: `${dateIn(ZONE, 2)}T23:59:00`, time_zone: ZONE });
  // Inbox: long title with a priority and tags (no due), plus a medium one.
  await apiCall(page, "POST", "/api/tasks", { title: `${LONG_TITLE} (inbox)`, priority: "high", tags: ["a", "b", "c"] });
  await apiCall(page, "POST", "/api/tasks", { title: "UX9 medium inbox", priority: "medium" });
  return project.id;
}

async function newPage(browser: Browser, state: Awaited<ReturnType<BrowserContext["storageState"]>>, size: (typeof SIZES)[number], theme: "light" | "dark") {
  const context = await browser.newContext({
    storageState: state,
    baseURL: process.env.ATLAS_E2E_BASE_URL,
    viewport: { width: size.width, height: size.height },
    hasTouch: size.touch,
    isMobile: size.touch && size.width < 700,
    colorScheme: theme,
    timezoneId: ZONE,
    locale: "en-GB",
  });
  const page = await context.newPage();
  await page.addInitScript((value) => localStorage.setItem("atlas-theme", value), theme);
  return { page, context };
}

async function settle(page: Page, path: string) {
  await page.goto(path);
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: /^Loading/ })).toHaveCount(0);
}

test("readability: layout, axe, row anatomy and targets at four sizes in both themes", async ({ page, browser }, testInfo) => {
  test.setTimeout(420_000);
  const projectId = await seed(page);
  const state = await page.context().storageState();
  const problems: Record<string, unknown> = {};
  const note = (key: string, value: unknown) => {
    problems[key] = value;
  };

  for (const theme of ["light", "dark"] as const) {
    for (const size of SIZES) {
      const { page: p, context } = await newPage(browser, state, size, theme);
      const phone = size.width <= 720;
      for (const path of [...PAGES, `/projects/${projectId}`]) {
        const label = `${path} ${size.name} ${theme}`;
        await settle(p, path);

        // No horizontal document scroll.
        const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        if (overflow > 0) note(`${label}: horizontal scroll`, overflow);

        // axe WCAG 2 A/AA (+ 2.1) and best practice.
        const result = await new AxeBuilder({ page: p })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"])
          .analyze();
        if (result.violations.length > 0) {
          note(
            `${label}: axe`,
            result.violations.map((v) => `${v.id} ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`),
          );
        }

        const metrics = await p.evaluate(() => {
          const rows = [...document.querySelectorAll<HTMLElement>(".task-row")].filter((r) => r.offsetParent !== null);
          return rows.map((row) => {
            const rect = row.getBoundingClientRect();
            const title = row.querySelector<HTMLElement>(".task-title");
            const lineHeight = 22;
            const titleLines = title ? Math.round(title.getBoundingClientRect().height / lineHeight) : 0;
            const metaGroups = row.querySelectorAll(".task-meta > .task-meta-when, .task-meta > .task-meta-context").length;
            const check = row.querySelector<HTMLElement>("input.task-check")?.getBoundingClientRect();
            const more = row.querySelector<HTMLElement>(".task-more")?.getBoundingClientRect();
            return {
              title: title?.textContent?.slice(0, 30) ?? "",
              height: Math.round(rect.height),
              titleLines,
              metaGroups,
              titleFs: title ? getComputedStyle(title).fontSize : "",
              overflowX: row.scrollWidth - row.clientWidth,
              check: check ? [Math.round(check.width), Math.round(check.height)] : null,
              more: more ? [Math.round(more.width), Math.round(more.height)] : null,
              body: row.querySelector(".task-body")?.getBoundingClientRect().height ?? 0,
            };
          });
        });
        if (path === "/week" && !phone) continue; // seven narrow columns: Week's layout is UX-10
        for (const row of metrics) {
          if (phone) {
            if (row.height > 96) note(`${label}: row "${row.title}" is ${row.height}px`, row);
            if (row.titleLines + row.metaGroups > 3) note(`${label}: row "${row.title}" has more than three lines`, row);
            if (row.overflowX > 1) note(`${label}: row "${row.title}" overflows by ${row.overflowX}px`, row);
            if (row.titleFs !== "16px") note(`${label}: title font ${row.titleFs}`, row.title);
          } else if (size.width >= 1440 && row.height > 40 && path !== "/week") {
            note(`${label}: desktop row "${row.title}" is ${row.height}px (> 40)`, row);
          }
          if (size.touch && row.check && (row.check[0] < 44 || row.check[1] < 44)) note(`${label}: checkbox ${row.check}`, row.title);
          if (size.touch && row.more && (row.more[0] < 44 || row.more[1] < 44)) note(`${label}: more button ${row.more}`, row.title);
        }
        if (phone && ["/", "/inbox", "/upcoming", "/tasks"].includes(path) && metrics.length === 0) note(`${label}: no rows`, true);
      }
      await context.close();
    }
  }
  expect(problems).toEqual({});

  // Greyscale evidence: the Today list stays readable without colour (icon + word).
  const { page: g, context } = await newPage(browser, state, SIZES[1], "light");
  await settle(g, "/");
  await g.addStyleTag({ content: "html{filter:grayscale(1)}" });
  await g.screenshot({ path: testInfo.outputPath("today-greyscale-390.png"), fullPage: true });
  await context.close();
});

test("a phone row says Overdue in words, opens from its meta, and headers stick under the mobile header", async ({ page, browser }) => {
  const projectId = await seed(page);
  expect(projectId).toBeTruthy();
  // A tall Overdue section, so there is something to scroll under the sticky header.
  for (let n = 1; n <= 8; n += 1) {
    await apiCall(page, "POST", "/api/tasks", { title: `UX9 filler ${n}`, status: "next", due_at: `${dateIn(ZONE, -3)}T0${n}:00:00`, time_zone: ZONE });
  }
  const { page: p, context } = await newPage(browser, await page.context().storageState(), SIZES[1], "light");
  await settle(p, "/");

  // Visible words, not only colour: the Overdue chip, the urgent flag word and the section header.
  // The three tests seed the same shared database, so a title can appear more than once.
  const row = p.locator(".task-row").filter({ hasText: "UX9 review and finalise" }).first();
  await expect(row.locator(".task-due")).toBeVisible();
  await expect(row.locator(".task-due")).toContainText("Overdue");
  await expect(row.locator(".task-priority")).toContainText("Urgent");
  await expect(row.locator(".task-tag")).toHaveCount(2);
  await expect(row.locator(".task-tag-more")).toContainText("+1");
  await expect(p.getByRole("heading", { name: "Overdue", level: 2 })).toBeVisible();
  // The project dot comes with the name.
  await expect(row.locator(".task-project .project-dot")).toHaveCount(1);
  await expect(row.locator(".task-project")).toContainText("UX9 Website relaunch");
  // A due today row in Today shows the word Today.
  await expect(p.locator(".task-row").filter({ hasText: "UX9 draft talk outline" }).first().locator(".task-due")).toContainText("Today");

  // The whole body opens the task: tap on the meta line, away from the title text.
  const meta = await row.locator(".task-meta-context").boundingBox();
  expect(meta).not.toBeNull();
  await p.mouse.click(meta!.x + meta!.width - 4, meta!.y + meta!.height / 2);
  await expect(taskPanel(p)).toBeVisible();
  await p.keyboard.press("Escape");
  await expect(taskPanel(p)).toBeHidden();

  // The Overdue header is sticky just below the 48px mobile header while its section scrolls.
  const header = p.getByRole("heading", { name: "Overdue", level: 2 });
  expect(await header.evaluate((el) => getComputedStyle(el).position)).toBe("sticky");
  expect(await header.evaluate((el) => getComputedStyle(el).top)).toBe("48px");
  await header.evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY + 150));
  const top = await header.evaluate((el) => Math.round(el.getBoundingClientRect().top));
  expect(top).toBeGreaterThanOrEqual(47);
  expect(top).toBeLessThanOrEqual(49);
  await context.close();
});

test("Upcoming drops the date from rows under a day header and keeps it where the list is not grouped by day", async ({ page, browser }) => {
  await seed(page);
  const { page: p, context } = await newPage(browser, await page.context().storageState(), SIZES[1], "light");
  await settle(p, "/upcoming");
  const plumber = p.locator(".task-row").filter({ hasText: "UX9 call the plumber" }).first();
  // Tomorrow's header is relative; the row keeps only the time (no weekday or month).
  await expect(p.getByRole("heading", { level: 2, name: /^Tomorrow · / })).toBeVisible();
  const due = await plumber.locator(".task-due").innerText();
  expect(due).toMatch(/10:30/);
  expect(due).not.toMatch(/[A-Z][a-z]{2}/);
  // The Tasks page is not grouped by day: the date stays.
  await settle(p, "/tasks");
  const flat = await p.locator(".task-row").filter({ hasText: "UX9 call the plumber" }).first().locator(".task-due").innerText();
  expect(flat).toMatch(/10:30/);
  expect(flat).toMatch(/[A-Z][a-z]{2}/);
  await context.close();
});
