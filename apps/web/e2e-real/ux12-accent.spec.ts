import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { expect, test } from "./fixtures";
import { apiCall, dateIn, ensureOwner } from "./helpers";

/**
 * UX-12 accent colours (ADR-0073), against the real stack. The picker in Settings -> Appearance is
 * operated by keyboard and persists; a stored accent is on <html> before the app script runs (no
 * flash); and every accent, in Light and Dark, passes axe on Today, Tasks, Notes, Calendar and
 * Settings with no horizontal scroll at 390 and 1440 px. The semantic colours must not move with the
 * accent. Set ATLAS_E2E_SHOTS=<dir> to write one screenshot per accent x page x width x theme.
 */
const ZONE = "UTC";
const SHOTS = process.env.ATLAS_E2E_SHOTS;
const ACCENTS = ["neutral", "blue", "indigo", "violet", "pink", "red", "orange", "amber", "green", "teal"] as const;
const WIDTHS = [
  { width: 390, height: 844, label: "phone" },
  { width: 1440, height: 900, label: "desktop" },
] as const;

async function seed(page: Page) {
  const project = await apiCall<{ id: string }>(page, "POST", "/api/projects", { name: "UX12 Website relaunch" });
  const common = { status: "next", project_id: project.id, time_zone: ZONE };
  await apiCall(page, "POST", "/api/tasks", { ...common, title: "UX12 overdue invoice", priority: "urgent", tags: ["finance"], due_at: `${dateIn(ZONE, -3)}T09:00:00` });
  await apiCall(page, "POST", "/api/tasks", { ...common, title: "UX12 due today review", priority: "high", due_at: `${dateIn(ZONE, 0)}T23:59:00` });
  await apiCall(page, "POST", "/api/tasks", { ...common, title: "UX12 later this week", due_at: `${dateIn(ZONE, 2)}T10:30:00` });
  await apiCall(page, "POST", "/api/tasks", { title: "UX12 inbox thought", priority: "medium" });
  const note = await apiCall<{ id: string }>(page, "POST", "/api/notes", {
    path: `ux12/Accent note ${Date.now()}.md`,
    content:
      "# Accent note\n\nA [link](https://example.com), a [[ux12/Accent note]] wiki link and a #planning tag.\n\n- [ ] A checklist item\n\n> A quote.\n",
  });
  return note.id;
}

async function settle(page: Page) {
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByText(/^Loading/)).toHaveCount(0);
  if (page.url().includes("/notes?open=")) {
    await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toBeVisible();
    await expect(page.locator(".cm-live-wikilink").first()).toBeVisible();
  }
  if (page.url().includes("/settings/appearance")) {
    await expect(page.getByRole("radiogroup", { name: "Accent colour" })).toBeVisible();
  }
  // Buttons and cards animate their colours: axe must not sample a mid-transition frame.
  await page.waitForTimeout(250);
}

test("the picker is a keyboard-operable radio group that applies at once and is remembered", async ({ page }) => {
  await ensureOwner(page);
  await page.goto("/settings/appearance");
  const group = page.getByRole("radiogroup", { name: "Accent colour" });
  await expect(group).toBeVisible();
  await expect(group.getByRole("radio")).toHaveCount(ACCENTS.length);
  await expect(group.getByRole("radio", { name: "Neutral (default)" })).toBeChecked();
  await expect(page.locator("html")).not.toHaveAttribute("data-accent", /.+/);

  // Keyboard: focus the checked radio, then arrows move and apply. Focus is visible.
  await group.getByRole("radio", { name: "Neutral (default)" }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("html")).toHaveAttribute("data-accent", "blue");
  await expect(group.getByRole("radio", { name: "Blue" })).toBeChecked();
  await expect(group.getByRole("radio", { name: "Blue" })).toBeFocused();
  const ring = await page.locator(".accent-option input:focus-visible + .accent-card").evaluate((el) => {
    const style = getComputedStyle(el);
    return { width: style.outlineWidth, style: style.outlineStyle };
  });
  expect(ring).toEqual({ width: "2px", style: "solid" });
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("html")).toHaveAttribute("data-accent", "indigo");

  // Selected state is not colour alone: a check mark is shown for the checked swatch only.
  await expect(page.locator(".accent-option input:checked + .accent-card .accent-check")).toBeVisible();
  await expect(page.locator(".accent-check:visible")).toHaveCount(1);

  // The primary action takes the accent (live preview): its background is the indigo token.
  const token = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
  expect(token).toBe("#5952e0");

  // Remembered across a reload, and still selected in the picker.
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-accent", "indigo");
  await expect(page.getByRole("radiogroup", { name: "Accent colour" }).getByRole("radio", { name: "Indigo" })).toBeChecked();
  expect(await page.evaluate(() => localStorage.getItem("atlas-accent"))).toBe("indigo");

  // It follows System/Light/Dark: the same accent has a different solid in Dark.
  await page.getByRole("radio", { name: "Dark" }).check();
  const dark = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
  expect(dark).toBe("#9894f0");
  await page.getByRole("radio", { name: "System" }).check();

  // Every target is at least 44px tall on a phone, and nothing scrolls sideways at 360.
  await page.setViewportSize({ width: 360, height: 800 });
  for (const card of await page.locator(".accent-card").all()) {
    const box = await card.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.width).toBeGreaterThanOrEqual(44);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);

  // Back to the default: the attribute and the stored value are gone.
  await page.getByRole("radiogroup", { name: "Accent colour" }).getByRole("radio", { name: "Neutral (default)" }).check();
  await expect(page.locator("html")).not.toHaveAttribute("data-accent", /.+/);
  expect(await page.evaluate(() => localStorage.getItem("atlas-accent"))).toBeNull();
});

test("a stored accent is on <html> before the app script runs, and an invalid one is ignored", async ({ page }) => {
  await ensureOwner(page);
  await page.addInitScript(() => localStorage.setItem("atlas-accent", "teal"));
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(/\/src\/main\.tsx/, async (route) => {
    await held;
    await route.continue();
  });
  const navigation = page.goto("/");
  await expect.poll(() => page.evaluate(() => document.readyState).catch(() => "loading")).not.toBe("loading");
  const early = await page.evaluate(() => ({
    accent: document.documentElement.dataset.accent ?? null,
    mounted: (document.getElementById("root")?.childElementCount ?? 0) > 0,
  }));
  expect(early).toEqual({ accent: "teal", mounted: false });
  release();
  await navigation;
  await page.unroute(/\/src\/main\.tsx/);

  await page.evaluate(() => localStorage.setItem("atlas-accent", "chartreuse"));
  await page.addInitScript(() => localStorage.setItem("atlas-accent", "chartreuse"));
  await page.reload();
  await expect(page.locator("html")).not.toHaveAttribute("data-accent", /.+/);
  await page.evaluate(() => localStorage.removeItem("atlas-accent"));
});

test("semantic colours do not move with the accent", async ({ page }) => {
  await ensureOwner(page);
  const names = ["--due-overdue", "--due-today", "--priority-urgent", "--priority-high", "--success", "--warning", "--danger", "--project-1", "--cal-1"];
  const read = () =>
    page.evaluate((list) => list.map((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim()), names);
  await page.goto("/");
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((value) => {
      localStorage.setItem("atlas-theme", value);
      document.documentElement.dataset.theme = value;
    }, theme);
    await page.evaluate(() => delete document.documentElement.dataset.accent);
    const baseline = await read();
    for (const accent of ACCENTS) {
      await page.evaluate((value) => (document.documentElement.dataset.accent = value), accent);
      expect(await read(), `${accent} ${theme}`).toEqual(baseline);
    }
  }
  await page.evaluate(() => {
    localStorage.removeItem("atlas-theme");
    delete document.documentElement.dataset.theme;
    delete document.documentElement.dataset.accent;
  });
});

test("headings take the accent when the switch is on, and nothing else does", async ({ page }) => {
  test.setTimeout(240_000);
  await ensureOwner(page);
  const noteId = await seed(page);
  const rgb = (name: string) =>
    page.evaluate((n) => {
      const probe = document.createElement("span");
      probe.style.color = `var(${n})`;
      document.body.appendChild(probe);
      const value = getComputedStyle(probe).color;
      probe.remove();
      return value;
    }, name);
  const color = (selector: string) =>
    page.locator(selector).first().evaluate((el) => getComputedStyle(el).color);

  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.evaluate(
      (t) => {
        localStorage.setItem("atlas-theme", t);
        localStorage.setItem("atlas-accent", "violet");
        localStorage.removeItem("atlas-accent-headings");
      },
      theme,
    );
    await page.goto("/");
    await settle(page);
    const accentText = await rgb("--accent-text");
    const text = await rgb("--text");
    const text3 = await rgb("--text-3");
    // On: page title, sidebar section labels. Not: row titles, the Overdue section header (semantic).
    expect(await color("main h1"), `${theme} h1`).toBe(accentText);
    expect(await color("button.sidebar-section-header"), `${theme} sidebar label`).toBe(accentText);
    expect(await color(".task-row .task-title"), `${theme} row title`).toBe(text);
    const overdue = page.locator("h2.section-head", { hasText: "Overdue" }).first();
    const overdueColor = await overdue.evaluate((el) => getComputedStyle(el).color);
    expect(overdueColor).not.toBe(accentText);
    expect(await color("main p.hint, main .muted, main .task-meta")).not.toBe(accentText);
    void text3;

    // Settings section title; the form labels stay neutral.
    await page.goto("/settings/appearance");
    await settle(page);
    expect(await color(".settings-pane h2"), `${theme} settings title`).toBe(accentText);
    expect(await color(".settings-row-label")).toBe(text);
    await expect(page.getByTestId("accent-heading-sample")).toHaveCSS("color", accentText);

    // Notes: preview headings, live headings (with their marks); body text and links-as-links unchanged.
    await page.goto(`/notes?open=${noteId}`);
    await settle(page);
    expect(await color(".cm-live-h1"), `${theme} live h1`).toBe(accentText);
    const preview = page.getByRole("button", { name: "Preview", exact: true });
    if ((await preview.getAttribute("aria-pressed")) !== "true") await preview.click();
    expect(await color('[data-testid="markdown-preview"] h1'), `${theme} preview h1`).toBe(accentText);
    expect(await color('[data-testid="markdown-preview"] p')).toBe(text);

    // Calendar: the period title and the page title.
    await page.goto("/calendar");
    await settle(page);
    expect(await color(".cal-range"), `${theme} calendar range`).toBe(accentText);

    // Off: everything goes back to neutral text at once (and survives a reload).
    await page.goto("/settings/appearance");
    await settle(page);
    await page.getByRole("switch", { name: "Colour headings with the accent" }).uncheck();
    await expect(page.locator("html")).not.toHaveAttribute("data-accent-text", /.+/);
    await expect(page.locator("html")).toHaveAttribute("data-accent", "violet");
    await expect(page.locator(".settings-pane h2").first()).toHaveCSS("color", text);
    await page.reload();
    await expect(page.getByRole("switch", { name: "Colour headings with the accent" })).not.toBeChecked();
    await expect(page.locator("html")).not.toHaveAttribute("data-accent-text", /.+/);
    await page.getByRole("switch", { name: "Colour headings with the accent" }).check();
    await expect(page.locator("html")).toHaveAttribute("data-accent-text", "on");

    // Neutral: the switch changes nothing (neutral text stays neutral).
    await page.evaluate(() => localStorage.removeItem("atlas-accent"));
    await page.reload();
    await expect(page.locator("html")).not.toHaveAttribute("data-accent-text", /.+/);
    expect(await color(".settings-pane h2")).toBe(text);
  }
  await page.evaluate(() => {
    localStorage.removeItem("atlas-theme");
    localStorage.removeItem("atlas-accent");
    localStorage.removeItem("atlas-accent-headings");
  });
  await page.emulateMedia({ colorScheme: null });
});

test("every accent passes axe on Today, Tasks, Notes, Calendar and Settings in Light and Dark, with no sideways scroll at 390 and 1440", async ({
  page,
}) => {
  // (10 accents + 9 with plain headings) x 2 themes x 5 pages x 2 widths = 380 axe runs plus 190 page loads.
  test.setTimeout(2_400_000);
  await ensureOwner(page);
  const noteId = await seed(page);
  const pages = [
    ["today", "/"],
    ["tasks", "/tasks"],
    ["notes", `/notes?open=${noteId}`],
    ["calendar", "/calendar"],
    ["settings", "/settings/appearance"],
  ] as const;
  // The full matrix took ~29 minutes on a CI runner. CI samples Neutral and three accents (light, dark, mid hue); the contrast of
  // every accent is checked by styles.test.ts and the full matrix runs locally (unset CI).
  const matrix = process.env.CI ? ACCENTS.filter((a) => ["neutral", "blue", "amber", "teal"].includes(a)) : ACCENTS;
  const found: string[] = [];
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });

  for (const accent of matrix) {
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      // "Colour headings with the accent" on (the default) and off; Neutral has nothing to colour.
      for (const headings of accent === "neutral" ? ([true] as const) : ([true, false] as const)) {
      await page.evaluate(
        ([a, t, h]) => {
          localStorage.setItem("atlas-theme", t);
          if (a === "neutral") localStorage.removeItem("atlas-accent");
          else localStorage.setItem("atlas-accent", a);
          if (h === "on") localStorage.removeItem("atlas-accent-headings");
          else localStorage.setItem("atlas-accent-headings", "off");
        },
        [accent, theme, headings ? "on" : "off"],
      );
      for (const [label, url] of pages) {
        for (const { width, height, label: size } of WIDTHS) {
          await page.setViewportSize({ width, height });
          await page.goto(url);
          await settle(page);
          const attr = await page.locator("html").getAttribute("data-accent");
          if ((attr ?? "neutral") !== accent) found.push(`${accent} ${theme} ${label}: <html data-accent> is ${attr}`);
          const text = await page.locator("html").getAttribute("data-accent-text");
          if ((text === "on") !== (headings && accent !== "neutral")) {
            found.push(`${accent} ${theme} ${label} headings ${headings}: <html data-accent-text> is ${text}`);
          }
          const result = await new AxeBuilder({ page })
            .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"])
            .analyze();
          for (const v of result.violations) {
            found.push(`${accent} ${theme} headings=${headings} ${label} ${width}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`);
          }
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (overflow > 0) found.push(`${accent} ${theme} headings=${headings} ${label} ${width}: horizontal overflow ${overflow}px`);
          if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${accent}-${label}-${size}-${theme}${headings ? "" : "-plainheadings"}.png`) });
        }
      }
      }
    }
  }
  await page.evaluate(() => {
    localStorage.removeItem("atlas-theme");
    localStorage.removeItem("atlas-accent");
    localStorage.removeItem("atlas-accent-headings");
  });
  await page.emulateMedia({ colorScheme: null });
  await page.setViewportSize({ width: 1280, height: 720 });
  expect(found, found.join("\n")).toEqual([]);
});
