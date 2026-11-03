import AxeBuilder from "@axe-core/playwright";
import type { Browser, BrowserContext, Locator, Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { apiCall, dateIn, ensureOwner } from "./helpers";

/**
 * UX-10 — Week agenda, phone capture (FAB + sheet), phone menu as a bottom sheet, 16 px inputs,
 * safe-area and 44 px targets (ADR-0063). Measured in a real browser at 360, 390, 768 and 1440 px in
 * both themes against the real API. Not covered here (needs a real device, see TESTING.md): the
 * real on-screen keyboard, notch and home-indicator insets, screen readers.
 */
const ZONE = "Europe/Stockholm";
test.use({ timezoneId: ZONE, locale: "en-GB" });

const SIZES = [
  { name: "360", width: 360, height: 740, touch: true },
  { name: "390", width: 390, height: 844, touch: true },
  { name: "768", width: 768, height: 1024, touch: true },
  { name: "1440", width: 1440, height: 900, touch: false },
] as const;
type Size = (typeof SIZES)[number];
const PAGES = ["/", "/inbox", "/upcoming", "/week", "/tasks"];
const LONG = "UX10 review and finalise the quarterly budget spreadsheet together with the accountant before Friday";

// The tests share one database: seed once, then only sign in.
let seeded: string | null = null;

async function seed(page: Page) {
  await ensureOwner(page);
  if (seeded) return seeded;
  // A failed test restarts the worker and loses `seeded`: look in the database first.
  const known = await apiCall<{ tasks: { title: string; project_id: string | null }[] }>(page, "GET", `/api/tasks?q=${encodeURIComponent("UX10 call the plumber")}`);
  if (known.tasks.length > 0 && known.tasks[0].project_id) {
    seeded = known.tasks[0].project_id;
    return seeded;
  }
  const project = await apiCall<{ id: string }>(page, "POST", "/api/projects", { name: "UX10 Website relaunch" });
  const when = (days: number, time: string) => ({ due_at: `${dateIn(ZONE, days)}T${time}`, time_zone: ZONE });
  await apiCall(page, "POST", "/api/tasks", { title: LONG, status: "next", priority: "urgent", project_id: project.id, tags: ["finance", "quarterly"], ...when(0, "09:00:00") });
  await apiCall(page, "POST", "/api/tasks", { title: "UX10 call the plumber about the boiler", status: "next", priority: "high", project_id: project.id, ...when(1, "10:30:00") });
  await apiCall(page, "POST", "/api/tasks", { title: "UX10 later this week", status: "next", ...when(2, "23:59:00") });
  await apiCall(page, "POST", "/api/tasks", { title: "UX10 inbox item one", priority: "medium", tags: ["a", "b"] });
  await apiCall(page, "POST", "/api/tasks", { title: "UX10 inbox item two" });
  seeded = project.id;
  return project.id;
}

async function newPage(browser: Browser, state: Awaited<ReturnType<BrowserContext["storageState"]>>, size: Size, theme: "light" | "dark") {
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

async function axe(page: Page) {
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]).analyze();
  return result.violations.map((v) => `${v.id} ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`);
}

/** The bottom edge of an element once its slide-up animation has finished. */
async function settledBottom(locator: Locator) {
  let last = -1;
  await expect
    .poll(async () => {
      const box = await locator.boundingBox();
      const bottom = box ? Math.round(box.y + box.height) : -2;
      const stable = bottom === last;
      last = bottom;
      return stable ? bottom : -3;
    })
    .toBeGreaterThan(0);
  const box = (await locator.boundingBox())!;
  return Math.round(box.y + box.height);
}

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** Controls inside a container that are smaller than 44 px in either direction (checkboxes excluded). */
function smallControls(root: Locator) {
  return root.evaluate((element) =>
    [...element.querySelectorAll<HTMLElement>("button, a[href], input:not([type=checkbox]):not([type=radio]), select, textarea, [role=menuitem]")]
      .map((control) => ({ control, rect: control.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width > 0 && rect.height > 0 && (rect.width < 43.5 || rect.height < 43.5))
      .map(({ control, rect }) => `${control.tagName} ${(control.getAttribute("aria-label") || control.textContent || "").trim().slice(0, 24)} ${Math.round(rect.width)}x${Math.round(rect.height)}`),
  );
}

test("layout, axe, 16 px fields and 44 px targets on Today, Inbox, Upcoming, Week and Tasks at four sizes in both themes", async ({ page, browser }) => {
  test.setTimeout(420_000);
  await seed(page);
  const state = await page.context().storageState();
  const problems: Record<string, unknown> = {};

  for (const theme of ["light", "dark"] as const) {
    for (const size of SIZES) {
      const { page: p, context } = await newPage(browser, state, size, theme);
      for (const path of PAGES) {
        const label = `${path} ${size.name} ${theme}`;
        await settle(p, path);
        const sideways = await overflow(p);
        if (sideways > 0) problems[`${label}: horizontal scroll`] = sideways;
        const violations = await axe(p);
        if (violations.length > 0) problems[`${label}: axe`] = violations;

        if (size.touch) {
          const fonts = await p.evaluate(() =>
            [...document.querySelectorAll<HTMLElement>("input:not([type=checkbox]):not([type=radio]), select, textarea")]
              .filter((el) => el.getBoundingClientRect().width > 0)
              .map((el) => getComputedStyle(el).fontSize)
              .filter((fs) => parseFloat(fs) < 16),
          );
          if (fonts.length > 0) problems[`${label}: text fields under 16px`] = fonts;
        }

        // The controls this task added or changed (nav, FAB, week navigation, rail).
        const changed = await p.evaluate(() => {
          const names = ["Capture a task", "Previous week", "This week", "Next week", "Search", "Show sidebar"];
          return [...document.querySelectorAll<HTMLElement>("button, a[href]")]
            .filter((el) => {
              const inNav = el.closest(".bottom-nav, .rail, .planning-nav, .mobile-header");
              const named = names.includes(el.getAttribute("aria-label") ?? "") || names.includes((el.textContent ?? "").trim());
              return (inNav || named) && el.getBoundingClientRect().width > 0;
            })
            .map((el) => ({ n: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 20), r: el.getBoundingClientRect() }))
            .filter(({ r }) => r.width < 43.5 || r.height < 43.5)
            .map(({ n, r }) => `${n} ${Math.round(r.width)}x${Math.round(r.height)}`);
        });
        if (size.touch && changed.length > 0) problems[`${label}: small changed controls`] = changed;

        if (path === "/week") {
          // All seven days, in the page, with no inner or outer sideways scroll and no clipped text.
          await expect(p.locator(".week-day")).toHaveCount(7);
          const week = await p.evaluate(() => {
            const container = document.querySelector<HTMLElement>(".week-agenda")!;
            const bounds = container.getBoundingClientRect();
            const cards = [...document.querySelectorAll<HTMLElement>(".week-day")];
            const columns = new Set(cards.map((card) => Math.round(card.getBoundingClientRect().left))).size;
            const inner = [...document.querySelectorAll<HTMLElement>(".week-page *")].filter((el) => el.clientWidth > 2 && el.scrollWidth - el.clientWidth > 1 && getComputedStyle(el).overflowX !== "visible" && !el.matches(".task-meta-when, .task-meta-context, .menu-label, .segmented-label") && !(window.innerWidth <= 390 && getComputedStyle(el).textOverflow === "ellipsis"));
            const clipped = [...document.querySelectorAll<HTMLElement>(".week-day .task-title")].filter((el) => el.scrollWidth - el.clientWidth > 1).map((el) => el.textContent?.slice(0, 20));
            const outside = cards.filter((card) => { const r = card.getBoundingClientRect(); return r.left < bounds.left - 1 || r.right > bounds.right + 1; }).length;
            // A word split across two lines (a mid-word break): any word whose rects span two rows.
            let midWord = 0;
            for (const title of document.querySelectorAll<HTMLElement>(".week-day .task-title")) {
              const walker = document.createTreeWalker(title, NodeFilter.SHOW_TEXT);
              for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                const text = node.textContent ?? "";
                for (const match of text.matchAll(/\S+/g)) {
                  const range = document.createRange();
                  range.setStart(node, match.index!);
                  range.setEnd(node, match.index! + match[0].length);
                  const rows = new Set([...range.getClientRects()].map((r) => Math.round(r.top)));
                  if (rows.size > 1) midWord += 1;
                }
              }
            }
            return {
              columns,
              inner: inner.map((el) => el.className),
              clipped,
              outside,
              midWord,
              today: document.querySelectorAll(".week-day.is-today").length,
              counts: [...document.querySelectorAll<HTMLElement>(".week-day > h2")].length,
              emptyHeights: [...document.querySelectorAll<HTMLElement>(".week-day.is-empty")].map((el) => Math.round(el.getBoundingClientRect().height)),
            };
          });
          if (week.inner.length > 0) problems[`${label}: inner scroll`] = week.inner;
          if (week.clipped.length > 0) problems[`${label}: clipped titles`] = week.clipped;
          if (week.outside > 0) problems[`${label}: cards outside the container`] = week.outside;
          if (week.midWord > 0) problems[`${label}: mid-word wrapping`] = week.midWord;
          if (week.today !== 1) problems[`${label}: today cards`] = week.today;
          if (size.width <= 390 && week.columns !== 1) problems[`${label}: columns`] = week.columns;
          if (size.width >= 768 && week.columns < 2) problems[`${label}: columns`] = week.columns;
          if (week.emptyHeights.some((h) => h > 64)) problems[`${label}: empty day not one line`] = week.emptyHeights;
          // The seven headings are all visible text (reachable without sideways scrolling).
          const headings = await p.getByRole("heading", { level: 2 }).filter({ hasText: /\d/ }).count();
          if (headings < 7) problems[`${label}: day headings`] = headings;
        }
      }
      await context.close();
    }
  }
  expect(problems).toEqual({});
});

test("phone capture: a button above the bottom nav opens a sheet that adds exactly one task; desktop keeps the inline field", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const projectId = await seed(page);
  const state = await page.context().storageState();

  for (const theme of ["light", "dark"] as const) {
    const { page: p, context } = await newPage(browser, state, SIZES[1], theme);
    for (const path of [...PAGES, `/projects/${projectId}`]) {
      await settle(p, path);
      const fab = p.getByRole("button", { name: "Capture a task" });
      await expect(fab, path).toBeVisible();
      // One tap away, above the bottom nav and the status bar, big enough, clear of the safe area.
      const fabBox = (await fab.boundingBox())!;
      const navBox = (await p.getByRole("navigation", { name: "Bottom navigation" }).boundingBox())!;
      expect(fabBox.width, path).toBeGreaterThanOrEqual(56);
      expect(fabBox.y + fabBox.height, path).toBeLessThanOrEqual(navBox.y);
      expect(fabBox.x + fabBox.width, path).toBeLessThanOrEqual(390);

      const title = `UX10 captured ${theme} ${path.replace(/\W+/g, "") || "today"}`;
      await fab.click();
      const sheet = p.getByRole("dialog", { name: "Capture a task" });
      await expect(sheet).toBeVisible();
      await expect(sheet.getByLabel("Task title")).toBeFocused();
      expect(await overflow(p)).toBe(0);
      expect(await smallControls(sheet), `${path} sheet targets`).toEqual([]);
      expect(await sheet.getByLabel("Task title").evaluate((el) => getComputedStyle(el).fontSize)).toBe("16px");
      // Docked to the bottom edge with the scrim above the bottom nav.
      expect(await settledBottom(sheet)).toBe(844);
      if (path === "/inbox" || path === "/") expect(await axe(p), `${path} ${theme} sheet axe`).toEqual([]);

      await sheet.getByLabel("Task title").fill(title);
      await sheet.getByRole("button", { name: "Add" }).click();
      await expect(sheet.getByRole("status")).toContainText(`Added “${title}”`);
      await expect(sheet.getByLabel("Task title")).toBeFocused();
      await sheet.getByRole("button", { name: "Close" }).click();
      await expect(sheet).toBeHidden();
      await expect(fab).toBeFocused();

      const found = await apiCall<{ tasks: { title: string }[] }>(p, "GET", `/api/tasks?q=${encodeURIComponent(title)}`);
      expect(found.tasks.filter((task) => task.title === title), `${path} created once`).toHaveLength(1);
    }
    // Esc closes and returns focus; the scrim closes too.
    await settle(p, "/upcoming");
    await p.getByRole("button", { name: "Capture a task" }).click();
    await p.keyboard.press("Escape");
    await expect(p.getByRole("dialog", { name: "Capture a task" })).toBeHidden();
    await expect(p.getByRole("button", { name: "Capture a task" })).toBeFocused();
    await p.getByRole("button", { name: "Capture a task" }).click();
    await p.mouse.click(190, 60);
    await expect(p.getByRole("dialog", { name: "Capture a task" })).toBeHidden();
    // Tab stays inside the sheet.
    await p.getByRole("button", { name: "Capture a task" }).click();
    for (let n = 0; n < 4; n += 1) await p.keyboard.press("Tab");
    expect(await p.evaluate(() => !!document.activeElement?.closest("[role=dialog]"))).toBe(true);
    await context.close();
  }

  // A failed add keeps the title and the retry adds one task (the request is the page's own, not retried by the sheet).
  const { page: q, context: qc } = await newPage(browser, state, SIZES[1], "light");
  await settle(q, "/inbox");
  let failOnce = true;
  await q.route("**/api/tasks", async (route) => {
    if (route.request().method() === "POST" && failOnce) {
      failOnce = false;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "Service unavailable" }) });
    } else {
      await route.fallback();
    }
  });
  await q.getByRole("button", { name: "Capture a task" }).click();
  const sheet = q.getByRole("dialog", { name: "Capture a task" });
  await sheet.getByLabel("Task title").fill("UX10 retried capture");
  await sheet.getByRole("button", { name: "Add" }).click();
  await expect(sheet.getByRole("alert")).toBeVisible();
  await expect(sheet.getByLabel("Task title")).toHaveValue("UX10 retried capture");
  await sheet.getByRole("button", { name: "Add" }).click();
  await expect(sheet.getByRole("status")).toContainText("Added “UX10 retried capture”");
  const retried = await apiCall<{ tasks: { title: string }[] }>(q, "GET", `/api/tasks?q=${encodeURIComponent("UX10 retried capture")}`);
  expect(retried.tasks).toHaveLength(1);
  await qc.close();

  // Desktop and tablet: no button, the inline field stays.
  for (const size of [SIZES[2], SIZES[3]]) {
    const { page: d, context: dc } = await newPage(browser, state, size, "light");
    await settle(d, "/inbox");
    await expect(d.getByRole("button", { name: "Capture a task" })).toHaveCount(0);
    await expect(d.getByLabel("Task title")).toBeVisible();
    await dc.close();
  }
  // Phone Today has no inline field (the sheet replaces it).
  const { page: t, context: tc } = await newPage(browser, state, SIZES[1], "light");
  await settle(t, "/");
  await expect(t.getByLabel("Task title")).toHaveCount(0);
  await tc.close();
});

test("the capture sheet lifts above the on-screen keyboard (visual viewport emulated)", async ({ page, browser }) => {
  await seed(page);
  const { page: p, context } = await newPage(browser, await page.context().storageState(), SIZES[1], "light");
  // Headless Chromium has no on-screen keyboard: a stand-in visualViewport reports one of 300 px.
  await p.addInitScript(() => {
    const listeners: Record<string, (() => void)[]> = {};
    const fake = {
      height: window.innerHeight,
      offsetTop: 0,
      addEventListener: (type: string, fn: () => void) => ((listeners[type] ||= []).push(fn)),
      removeEventListener: () => {},
    };
    Object.defineProperty(window, "visualViewport", { value: fake, configurable: true });
    (window as unknown as { __keyboard: (px: number) => void }).__keyboard = (px) => {
      fake.height = window.innerHeight - px;
      (listeners.resize ?? []).forEach((fn) => fn());
    };
  });
  await settle(p, "/inbox");
  await p.getByRole("button", { name: "Capture a task" }).click();
  const sheet = p.getByRole("dialog", { name: "Capture a task" });
  expect(await settledBottom(sheet)).toBe(844);
  await p.evaluate(() => (window as unknown as { __keyboard: (px: number) => void }).__keyboard(300));
  await expect.poll(() => settledBottom(sheet)).toBe(844 - 300);
  // The field stays in the visible part of the window.
  const input = (await sheet.getByLabel("Task title").boundingBox())!;
  expect(input.y + input.height).toBeLessThanOrEqual(844 - 300);
  await p.evaluate(() => (window as unknown as { __keyboard: (px: number) => void }).__keyboard(0));
  await expect.poll(() => settledBottom(sheet)).toBe(844);
  await context.close();
});

test("the row menu is a bottom sheet on a phone and a popover on desktop, with the same roles", async ({ page, browser }) => {
  test.setTimeout(240_000);
  await seed(page);
  const state = await page.context().storageState();

  for (const theme of ["light", "dark"] as const) {
    for (const size of [SIZES[0], SIZES[1], SIZES[2]]) {
      const { page: p, context } = await newPage(browser, state, size, theme);
      await settle(p, "/inbox");
      const opener = p.getByRole("button", { name: /^Actions for UX10 inbox item one/ });
      await opener.click();
      const menu = p.getByRole("menu");
      await expect(menu).toBeVisible();
      await expect(menu).toHaveClass(/is-sheet/);
      expect(await menu.evaluate((el) => getComputedStyle(el).position)).toBe("fixed");
      expect(await settledBottom(menu), size.name).toBe(size.height);
      const box = (await menu.boundingBox())!;
      expect(Math.round(box.x), size.name).toBe(0);
      expect(Math.round(box.width), size.name).toBe(size.width);
      expect(await smallControls(menu), `${size.name} ${theme} menu targets`).toEqual([]);
      await expect(p.locator(".sheet-scrim")).toHaveCount(1);
      expect(await overflow(p)).toBe(0);
      expect(await axe(p), `${size.name} ${theme} row sheet axe`).toEqual([]);
      // Same menu semantics: items, a radio submenu, a trailing Cancel; focus starts on the first item.
      await expect(menu.getByRole("menuitem", { name: "Today" })).toBeFocused();
      await expect(menu.getByRole("menuitem", { name: "Priority" })).toBeVisible();
      await p.keyboard.press("End");
      await expect(menu.getByRole("menuitem", { name: "Cancel" })).toBeFocused();
      await p.keyboard.press("Tab");
      await expect(menu.getByRole("menuitem", { name: "Today" })).toBeFocused();
      await menu.getByRole("menuitem", { name: "Priority" }).click();
      await expect(p.getByRole("menu", { name: "Priority" }).getByRole("menuitemradio")).toHaveCount(5);
      expect(await axe(p), `${size.name} ${theme} priority sheet axe`).toEqual([]);
      await p.keyboard.press("Escape");
      await expect(p.getByRole("menu")).toHaveCount(0);
      await expect(opener).toBeFocused();

      // The scrim dismisses and focus goes back too; choosing an item works from the sheet.
      await opener.click();
      await p.mouse.click(size.width / 2, 60);
      await expect(p.getByRole("menu")).toHaveCount(0);
      await expect(opener).toBeFocused();
      await opener.click();
      await p.getByRole("menuitem", { name: "Priority" }).click();
      await p.getByRole("menuitemradio", { name: "High" }).click();
      await expect(p.getByRole("menu")).toHaveCount(0);
      await context.close();
    }
  }

  const { page: d, context: dc } = await newPage(browser, state, SIZES[3], "light");
  await settle(d, "/inbox");
  await d.getByRole("button", { name: /^Actions for UX10 inbox item two/ }).click();
  const popover = d.getByRole("menu");
  await expect(popover).toBeVisible();
  await expect(popover).not.toHaveClass(/is-sheet/);
  await expect(d.locator(".sheet-scrim")).toHaveCount(0);
  await expect(popover.getByRole("menuitem", { name: "Cancel" })).toHaveCount(0);
  expect((await popover.boundingBox())!.width).toBeLessThanOrEqual(320);
  await d.keyboard.press("Escape");
  await dc.close();
});

test("the phone chrome pads for safe areas: the bottom nav and the sheet keep their targets when an inset exists", async ({ page, browser }) => {
  await seed(page);
  const { page: p, context } = await newPage(browser, await page.context().storageState(), SIZES[1], "light");
  await settle(p, "/");
  // Emulate a 34 px home-indicator inset by overriding the variable the CSS reads.
  await p.addStyleTag({ content: ":root{--safe-bottom:34px;--safe-top:47px}" });
  const nav = (await p.getByRole("navigation", { name: "Bottom navigation" }).boundingBox())!;
  expect(Math.round(nav.height)).toBe(56 + 34);
  expect(Math.round(nav.y + nav.height)).toBe(844);
  const link = (await p.getByRole("navigation", { name: "Bottom navigation" }).getByRole("link", { name: "Inbox" }).boundingBox())!;
  expect(link.height).toBeGreaterThanOrEqual(44);
  expect(link.y + link.height).toBeLessThanOrEqual(nav.y + 1 + 56);
  const header = (await p.locator(".mobile-header").boundingBox())!;
  expect(Math.round(header.height)).toBe(48 + 47);
  // The FAB stays above the taller nav, and the sheet reserves the inset below its controls.
  const fab = (await p.getByRole("button", { name: "Capture a task" }).boundingBox())!;
  expect(fab.y + fab.height).toBeLessThanOrEqual(nav.y);
  await p.getByRole("button", { name: "Capture a task" }).click();
  const sheet = p.getByRole("dialog", { name: "Capture a task" });
  await settledBottom(sheet);
  const add = (await sheet.getByRole("button", { name: "Add" }).boundingBox())!;
  const bottom = await settledBottom(sheet);
  expect(bottom - (add.y + add.height)).toBeGreaterThanOrEqual(34);
  await context.close();
});
