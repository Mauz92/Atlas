import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { apiCall, ensureOwner } from "./helpers";

/**
 * Calendar Stage A (M5-05, M5-07, M5-11, ADR-0071) against the real stack and the **fake provider**
 * (global-setup starts it; nothing here contacts Google, Microsoft or Proton). It links an ICS feed,
 * runs the full Google OAuth redirect (PKCE, state, callback) and the Microsoft one, syncs, then
 * checks Today, the four Calendar views, the detail sheet, disconnect, accessibility in both themes at
 * 360/390/768/1440 px and that no page scrolls sideways. Screenshots go to ATLAS_E2E_SHOTS when set.
 */
const FAKE = () => process.env.ATLAS_E2E_FAKE_PROVIDER_URL!;
const SHOTS = process.env.ATLAS_E2E_SHOTS;
const SECRET = "protonSECRETlink4455";

function iso(day: Date, hour: number, minute = 0) {
  const d = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, minute));
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}
function ymd(day: Date) {
  return day.toISOString().slice(0, 10).replace(/-/g, "");
}

async function control(body: unknown) {
  const response = await fetch(`${FAKE()}/_control`, { method: "POST", body: JSON.stringify(body) });
  expect(response.ok).toBeTruthy();
}

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

async function violations(page: Page) {
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]).analyze();
  return result.violations.map((v) => ({ id: v.id, help: v.help, nodes: v.nodes.map((n) => n.target.join(" ")).slice(0, 4) }));
}

async function noSidewaysScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
}

function feedBody(day: Date) {
  const tomorrow = new Date(day.getTime() + 86_400_000);
  const nextWeek = new Date(day.getTime() + 3 * 86_400_000);
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//fixture//EN", "X-WR-TIMEZONE:Europe/Berlin",
    "BEGIN:VEVENT", "UID:standup", `DTSTAMP:${iso(day, 8)}`, `DTSTART:${iso(day, 8)}`, `DTEND:${iso(day, 9)}`,
    "SUMMARY:Standup", "LOCATION:Room 2", "DESCRIPTION:Bring <b>slides</b>", "RRULE:FREQ=DAILY;COUNT=10", "END:VEVENT",
    "BEGIN:VEVENT", "UID:review", `DTSTAMP:${iso(day, 8)}`, `DTSTART:${iso(day, 8, 30)}`, `DTEND:${iso(day, 10)}`, "SUMMARY:Design review (overlaps)", "END:VEVENT",
    "BEGIN:VEVENT", "UID:trip", `DTSTAMP:${iso(day, 8)}`, `DTSTART;VALUE=DATE:${ymd(tomorrow)}`, `DTEND;VALUE=DATE:${ymd(nextWeek)}`, "SUMMARY:Conference trip", "END:VEVENT",
    "END:VCALENDAR", "",
  ].join("\r\n");
}

test.describe.configure({ mode: "serial" });

test("link a feed, an OAuth Google and Microsoft account, then use the calendar", async ({ page }) => {
  test.setTimeout(240_000);
  const today = new Date();
  await ensureOwner(page);
  await control({ op: "reset" });
  await control({ op: "ics", name: "proton.ics", body: feedBody(today), options: { etag: '"v1"' } });
  await page.setViewportSize({ width: 1280, height: 900 });

  // --- Settings -> Calendar: three cards, nothing connected, status bar honest.
  await page.goto("/settings/calendar");
  const cards = page.locator(".cal-card");
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(0).getByRole("button", { name: "Connect Google Calendar" })).toBeVisible();
  await expect(page.getByText("Calendar not connected")).toBeVisible();
  await shot(page, "settings-calendar-not-connected");

  // --- ICS feed: test (count only), add, masked afterwards, sync.
  const url = `${FAKE()}/ics/proton.ics`;
  await page.getByLabel("Feed link (secret)").fill(url);
  await page.getByRole("textbox", { name: "Name" }).fill("Proton");
  await page.getByRole("button", { name: "Test feed" }).click();
  await expect(page.getByText(/Readable calendar with 3 events/)).toBeVisible();
  await page.getByRole("button", { name: "Add feed" }).click();
  const feed = page.locator(".cal-card[data-provider='ics']");
  await expect(feed.getByRole("checkbox", { name: /Proton/ })).toBeChecked();
  await expect(feed.getByLabel("Feed link, masked")).toContainText("••••");
  await expect(page.getByLabel("Feed link (secret)")).toHaveValue("");
  await feed.getByRole("button", { name: "Sync now" }).click();
  await expect(feed.getByText(/Last synced|Synced|ago|just now/i).first()).toBeVisible();
  await expect(page.getByText("Calendar not connected")).toBeHidden();

  // The secret never comes back from the API.
  const accounts = JSON.stringify(await apiCall(page, "GET", "/api/calendar/accounts"));
  expect(accounts).not.toContain("proton.ics");
  await shot(page, "settings-calendar-feed-connected");

  // --- Google OAuth through the fake provider (PKCE + state + callback), then calendars.
  await control({
    op: "google_event",
    calendar_id: "owner@example.test",
    event: {
      id: "g1", status: "confirmed", summary: "Dentist (Google)", etag: '"g1"', updated: "2026-11-01T10:00:00Z",
      start: { dateTime: `${today.toISOString().slice(0, 10)}T14:00:00+00:00`, timeZone: "Europe/Berlin" },
      end: { dateTime: `${today.toISOString().slice(0, 10)}T15:00:00+00:00`, timeZone: "Europe/Berlin" },
    },
  });
  await page.getByRole("button", { name: "Connect Google Calendar" }).click();
  await expect(page.getByText(/Google Calendar is connected/)).toBeVisible();
  await expect(page).toHaveURL(/\/settings\/calendar$/); // the result code is removed from the address bar
  const google = page.locator(".cal-card[data-provider='google']");
  await expect(google.getByText("Connected", { exact: true })).toBeVisible();
  await expect(google.getByRole("checkbox", { name: /Owner/ })).toBeChecked();
  await expect(google.getByRole("checkbox", { name: /Holidays/ })).not.toBeChecked();
  await expect(google.getByText("Read only")).toBeVisible();
  await google.getByRole("button", { name: "Sync now" }).click();
  await expect(google.getByText(/Last synced|ago|just now/i).first()).toBeVisible();
  await google.getByRole("button", { name: /^Colour of Owner/ }).click();
  await page.getByRole("radio", { name: "Purple" }).click();
  await expect(google.getByRole("button", { name: "Colour of Owner: Purple" })).toBeVisible();
  await shot(page, "settings-calendar-google-connected");

  // --- Microsoft: connect, then a revoked grant asks for re-authorisation.
  await page.getByRole("button", { name: "Connect Microsoft Outlook" }).click();
  await expect(page.getByText(/Microsoft Outlook is connected/)).toBeVisible();
  await control({ op: "set", values: { fail_refresh: true } });
  await control({ op: "expire_tokens" });
  const microsoft = page.locator(".cal-card[data-provider='microsoft']");
  await microsoft.getByRole("button", { name: "Sync now" }).click();
  await expect(page.getByText("Needs re-authorisation", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reconnect" })).toBeVisible();
  await expect(page.getByText("Calendar needs re-authorisation")).toBeVisible();
  await shot(page, "settings-calendar-needs-reauth");
  await control({ op: "set", values: { fail_refresh: false } });
  await page.getByRole("button", { name: "Reconnect" }).click();
  await expect(page.getByText(/Microsoft Outlook is connected/)).toBeVisible();
  // The provider redirect returns through a page load that then cleans the address bar; do not start a page.evaluate
  // (apiCall) while that navigation is still in flight ("Execution context was destroyed", seen on a CI runner).
  await expect(page).toHaveURL(/\/settings\/calendar$/);
  await page.waitForLoadState("networkidle");

  // --- Today: the events slot shows today's events, tasks stay separate.
  await apiCall(page, "POST", "/api/tasks", { title: "Deadline task", due_at: `${today.toISOString().slice(0, 10)}T20:00:00`, time_zone: "UTC", status: "next" });
  await page.goto("/");
  const events = page.getByRole("region", { name: "Events" });
  await expect(events.getByRole("button", { name: /Standup/ })).toBeVisible();
  await expect(events.getByRole("button", { name: /Dentist \(Google\)/ })).toBeVisible();
  await expect(events.getByText("Deadline task")).toHaveCount(0); // a task deadline is never an event
  await shot(page, "today-with-events");

  // --- Calendar page: all four views, detail sheet, keyboard.
  await page.goto("/calendar");
  await expect(page.getByRole("heading", { name: "Calendar", level: 1 })).toBeVisible();
  for (const view of ["Day", "Week", "Month", "Agenda"]) {
    await page.getByRole("button", { name: view, exact: true }).click();
    await expect(page.getByRole("button", { name: view, exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: /Standup/ }).first()).toBeVisible();
    await shot(page, `calendar-${view.toLowerCase()}-desktop-light`);
  }
  await page.getByRole("button", { name: "Week", exact: true }).click();
  await expect(page.getByRole("group", { name: "All-day events" }).getByRole("button", { name: /Conference trip/ }).first()).toBeVisible();
  await page.getByRole("button", { name: /Design review/ }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Read only")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: /Standup/ }).first().click();
  await expect(page.getByRole("dialog").getByText("Bring <b>slides</b>")).toBeVisible(); // plain text, not HTML
  await shot(page, "calendar-event-detail-desktop");
  await page.keyboard.press("Escape");
  await page.keyboard.press("m");
  await expect(page.getByRole("button", { name: "Month", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("t");

  // --- Hiding a calendar removes its events; disconnect explains and deletes.
  await page.goto("/settings/calendar");
  const owner = page.locator(".cal-card[data-provider='google']").getByRole("checkbox", { name: /Owner/ });
  await owner.uncheck();
  await expect(owner).toBeEnabled(); // the save has finished
  await page.goto("/calendar");
  await page.getByRole("button", { name: "Agenda", exact: true }).click();
  await expect(page.getByRole("button", { name: /Dentist \(Google\)/ })).toHaveCount(0);
  await page.goto("/settings/calendar");
  const again = page.locator(".cal-card[data-provider='google']").getByRole("checkbox", { name: /Owner/ });
  await again.check();
  await expect(again).toBeEnabled();
  await page.locator(".cal-card[data-provider='google']").getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByText(/deletes the saved sign-in/)).toBeVisible();
  await page.getByRole("button", { name: "Disconnect and delete stored events" }).click();
  await expect(page.getByText(/stored events were removed/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect Google Calendar" })).toBeVisible();
  // The feed's events remain.
  await page.goto("/calendar");
  await expect(page.getByRole("button", { name: /Standup/ }).first()).toBeVisible();
});

test("a broken feed shows a safe error and keeps the last events", async ({ page }) => {
  await ensureOwner(page);
  await control({ op: "ics", name: "proton.ics", body: "x", options: { status: 404 } });
  await page.goto("/settings/calendar");
  const feed = page.locator(".cal-card[data-provider='ics']");
  await feed.getByRole("button", { name: "Sync now" }).click();
  await expect(page.getByRole("alert").filter({ hasText: /link rejected|rejected/i }).first()).toBeVisible();
  await expect(page.getByText(SECRET)).toHaveCount(0);
  await shot(page, "settings-calendar-feed-error");
  await page.goto("/calendar");
  await expect(page.getByRole("button", { name: /Standup/ }).first()).toBeVisible();
});

test("accessibility and layout: axe-clean in both themes, no sideways scroll, at four widths", async ({ page }) => {
  test.setTimeout(420_000);
  await ensureOwner(page);
  await control({ op: "ics", name: "proton.ics", body: feedBody(new Date()), options: { etag: '"v2"' } });
  await page.goto("/settings/calendar");
  await page.locator(".cal-card[data-provider='ics']").getByRole("button", { name: "Sync now" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  const found: Record<string, unknown> = {};
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.evaluate((value) => localStorage.setItem("atlas-theme", value), theme);
    for (const width of [360, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: width < 500 ? 800 : 900 });
      for (const view of ["agenda", "day", "week", "month"]) {
        await page.evaluate((value) => localStorage.setItem("atlas-calendar-view", value), view);
        await page.goto("/calendar");
        await expect(page.getByRole("button", { name: /Standup/ }).first()).toBeVisible();
        await noSidewaysScroll(page);
        const list = await violations(page);
        if (list.length) found[`/calendar ${view} ${width} ${theme}`] = list;
        if (width === 360 || width === 1440) await shot(page, `calendar-${view}-${width}-${theme}`);
      }
      await page.goto("/calendar");
      await page.getByRole("button", { name: /Standup/ }).first().click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await noSidewaysScroll(page);
      const detail = await violations(page);
      if (detail.length) found[`event detail ${width} ${theme}`] = detail;
      if (width === 360) await shot(page, `calendar-event-detail-${width}-${theme}`);
      await page.keyboard.press("Escape");
      for (const path of ["/settings/calendar", "/", "/week"]) {
        await page.goto(path);
        await page.getByRole("heading", { level: 1 }).or(page.getByRole("heading", { level: 2 })).first().waitFor();
        await noSidewaysScroll(page);
        const list = await violations(page);
        if (list.length) found[`${path} ${width} ${theme}`] = list;
        if (path === "/settings/calendar" && (width === 360 || width === 1440)) await shot(page, `settings-calendar-${width}-${theme}`);
      }
    }
  }
  expect(found).toEqual({});
});
