import AxeBuilder from "@axe-core/playwright";
import type { APIRequestContext, Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { expect, test } from "./fixtures";
import { ensureOwner, OWNER } from "./helpers";

/**
 * SYNC-11a in a real browser against the real API. Two device clients (bearer tokens, sync mode)
 * make the changes a second computer would make; the page is the owner's browser. Covers: the
 * "changed on another device" banner, the Changes page with Undo (happy path, "changed again since"
 * refusal, a kind that cannot be undone with its follow-up), the task text-conflict resolver, the note
 * conflict resolver (merge in the editor, keep mine), and axe / overflow sweeps of every new screen at
 * 360/390/768/1440 px in both themes. Set `SYNC11_SHOTS=<dir>` to also write screenshots.
 */
const BASE = () => process.env.ATLAS_E2E_BASE_URL!;
const SHOTS = process.env.SYNC11_SHOTS;

interface Device {
  token: string;
  device: { id: string; name: string };
}

async function signInDevice(request: APIRequestContext, name: string, platform: string): Promise<Device> {
  const response = await request.post(`${BASE()}/api/devices`, {
    data: { email: OWNER.email, password: OWNER.password, name, platform },
  });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()) as Device;
}

function headers(device: Device) {
  return { Authorization: `Bearer ${device.token}`, "Atlas-Sync": "1", "Idempotency-Key": crypto.randomUUID() };
}

async function json<T = Record<string, unknown>>(response: { status(): number; text(): Promise<string>; json(): Promise<unknown> }, status: number): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return (await response.json()) as T;
}

const WIDTHS = [360, 390, 768, 1440] as const;
const THEMES = ["light", "dark"] as const;

/** Axe, no horizontal overflow, and (optionally) screenshots, at every width in both themes. */
async function sweep(page: Page, label: string) {
  const found: string[] = [];
  for (const theme of THEMES) {
    await page.emulateMedia({ colorScheme: theme });
    await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
    await page.waitForTimeout(300); // buttons and cards animate their colours: axe must not sample a mid-transition frame
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]).analyze();
      for (const v of result.violations) found.push(`${label} ${theme} ${width}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 0) found.push(`${label} ${theme} ${width}: horizontal overflow ${overflow}px`);
      if (SHOTS && (width === 390 || width === 1440)) {
        mkdirSync(SHOTS, { recursive: true });
        await page.screenshot({ path: path.join(SHOTS, `${label}-${width === 390 ? "phone" : "desktop"}-${theme}.png`), fullPage: false });
      }
    }
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  expect(found, found.join("\n")).toEqual([]);
}

test("another device's change shows a banner and a Changes page with Undo, honest refusals and follow-ups", async ({ page, playwright }) => {
  test.setTimeout(240_000);
  await ensureOwner(page);
  const ctx = await playwright.request.newContext();
  const laptop = await signInDevice(ctx, "Kim's laptop", "linux");
  const phone = await signInDevice(ctx, "Pixel phone", "android");

  // --- a field changed on both devices: the later write wins, the earlier value is the undo target
  const task = await json<{ id: string; revision: number }>(
    await ctx.post(`${BASE()}/api/tasks`, { headers: headers(laptop), data: { title: "SYNC11 undo me" } }),
    201,
  );
  await json(await ctx.patch(`${BASE()}/api/tasks/${task.id}`, { headers: headers(laptop), data: { priority: "high", base_revision: task.revision } }), 200);
  await json(await ctx.patch(`${BASE()}/api/tasks/${task.id}`, { headers: headers(phone), data: { priority: "urgent", base_revision: task.revision } }), 200);

  await page.goto("/");
  const banner = page.getByRole("region", { name: "Changed on another device" });
  await expect(banner).toContainText("1 change was made on another device");
  await sweep(page, "sync11-banner");
  await banner.getByRole("link", { name: "Review" }).click();
  await expect(page).toHaveURL(/\/changes$/);
  await expect(page.getByRole("heading", { name: "Changes from other devices" })).toBeVisible();
  const card = page.getByRole("listitem").filter({ hasText: "Pixel phone" });
  await expect(card).toContainText("Replaced priority");
  await expect(card).toContainText("High");
  await expect(card.getByRole("link", { name: "SYNC11 undo me" })).toBeVisible();
  await expect(banner).toBeHidden(); // opening the page marks it seen

  // Undo: the earlier value is back, the entry says so, and there is no Undo button left on it
  await card.getByRole("button", { name: /Undo the change to the priority of SYNC11 undo me/ }).click();
  await expect(card.getByRole("status")).toContainText("Undone: the priority has its earlier value again");
  await expect(card.getByText("Undone", { exact: true })).toBeVisible();
  const after = await json<{ priority: string }>(await page.request.get(`/api/tasks/${task.id}`), 200);
  expect(after.priority).toBe("high");

  // --- "changed again since": a second conflict, then another edit on top of the winner
  const t2 = await json<{ id: string; revision: number; priority: string }>(await page.request.get(`/api/tasks/${task.id}`), 200);
  await json(await ctx.patch(`${BASE()}/api/tasks/${task.id}`, { headers: headers(laptop), data: { priority: "low", base_revision: t2.revision } }), 200);
  const winner = await json<{ revision: number }>(
    await ctx.patch(`${BASE()}/api/tasks/${task.id}`, { headers: headers(phone), data: { priority: "medium", base_revision: t2.revision } }),
    200,
  );
  await json(await ctx.patch(`${BASE()}/api/tasks/${task.id}`, { headers: headers(laptop), data: { priority: "urgent", base_revision: winner.revision } }), 200);
  await page.goto("/changes");
  const undo = page.getByRole("button", { name: /Undo the change to the priority of SYNC11 undo me/ });
  await expect(undo).toHaveCount(1);
  await undo.click();
  await expect(page.getByText(/Not undone: the priority was changed again since/)).toBeVisible();
  await expect(page.getByText(/never overwrites a newer value/)).toBeVisible();
  expect((await json<{ priority: string }>(await page.request.get(`/api/tasks/${task.id}`), 200)).priority).toBe("urgent");
  await expect(undo).toBeEnabled(); // the entry stays; nothing was lost

  // --- a kind that cannot be undone: two non-overlapping note edits merged by the server
  const base = "# Title\n\nalpha\n\nbeta\n\ngamma\n\ndelta\n";
  const note = await json<{ id: string; revision: number; content_hash: string }>(
    await ctx.post(`${BASE()}/api/notes`, { headers: headers(laptop), data: { path: "SYNC11 merged.md", content: base } }),
    201,
  );
  const put = (device: Device, content: string) =>
    ctx.put(`${BASE()}/api/notes/${note.id}`, { headers: headers(device), data: { content, base_revision: note.revision, base_hash: note.content_hash } });
  await json(await put(laptop, base.replace("alpha", "ALPHA")), 200);
  await json(await put(phone, base.replace("delta", "DELTA")), 200);
  await page.goto("/changes");
  const merged = page.getByRole("listitem").filter({ hasText: "merged both edits" });
  await expect(merged).toContainText("Pixel phone");
  await expect(merged.getByRole("button", { name: /Undo/ })).toHaveCount(0);
  await expect(merged).toContainText("cannot be reversed in one step");
  await expect(merged.getByRole("link", { name: "Open the note and compare it with the other version" })).toHaveAttribute("href", `/notes?open=${note.id}`);

  await sweep(page, "sync11-changes");
});

test("a text conflict on a task keeps both versions and saves the chosen text as a normal edit", async ({ page, playwright }) => {
  test.setTimeout(180_000);
  await ensureOwner(page);
  const ctx = await playwright.request.newContext();
  const laptop = await signInDevice(ctx, "Resolver laptop", "linux");
  const task = await json<{ id: string; revision: number }>(
    await ctx.post(`${BASE()}/api/tasks`, { headers: headers(laptop), data: { title: "SYNC11 shared title" } }),
    201,
  );
  await page.goto(`/tasks?task=${task.id}`);
  const panel = page.getByRole("dialog", { name: "Task details" });
  await expect(panel.getByLabel("Title")).toHaveValue("SYNC11 shared title");

  // the other device changes the title while the panel is open
  await json(await ctx.patch(`${BASE()}/api/tasks/${task.id}`, { headers: headers(laptop), data: { title: "SYNC11 their title", base_revision: task.revision } }), 200);
  await panel.getByLabel("Title").fill("SYNC11 my title");
  await panel.getByLabel("Title").blur();
  await expect(panel.getByText(/changed somewhere else/)).toBeVisible();
  await panel.getByRole("button", { name: "Load latest version" }).click();
  const resolver = panel.getByRole("group", { name: /Two versions of the title/ });
  await expect(resolver).toContainText("SYNC11 my title");
  await expect(resolver).toContainText("SYNC11 their title");
  expect((await json<{ title: string }>(await ctx.get(`${BASE()}/api/tasks/${task.id}`, { headers: headers(laptop) }), 200)).title).toBe("SYNC11 their title");
  await sweep(page, "sync11-task-resolver");

  await resolver.getByRole("button", { name: "Edit merged title" }).click();
  await resolver.getByLabel("Merged title").fill("SYNC11 merged title");
  await resolver.getByRole("button", { name: "Save merged title" }).click();
  await expect(panel.getByRole("group", { name: /Two versions of the title/ })).toBeHidden();
  await expect.poll(async () => (await json<{ title: string }>(await ctx.get(`${BASE()}/api/tasks/${task.id}`, { headers: headers(laptop) }), 200)).title).toBe("SYNC11 merged title");
});

test("a note conflict copy is resolved next to its original: merge in the editor, or keep mine", async ({ page, playwright }) => {
  test.setTimeout(240_000);
  await ensureOwner(page);
  const ctx = await playwright.request.newContext();
  const laptop = await signInDevice(ctx, "Note laptop", "linux");
  const phone = await signInDevice(ctx, "Note phone", "android");
  const base = "# Plan\n\nthe line everyone edits\n\nend\n";

  async function conflict(name: string, theirs: string, mine: string) {
    const note = await json<{ id: string; revision: number; content_hash: string }>(
      await ctx.post(`${BASE()}/api/notes`, { headers: headers(laptop), data: { path: name, content: base } }),
      201,
    );
    const put = (device: Device, content: string) =>
      ctx.put(`${BASE()}/api/notes/${note.id}`, { headers: headers(device), data: { content, base_revision: note.revision, base_hash: note.content_hash } });
    await json(await put(laptop, theirs), 200);
    const refused = await put(phone, mine);
    expect(refused.status(), await refused.text()).toBe(409); // overlapping edit: kept as a conflict copy
    return note.id;
  }

  const first = await conflict("SYNC11 plan one.md", base.replace("everyone edits", "server version"), base.replace("everyone edits", "my version"));
  const second = await conflict("SYNC11 plan two.md", base.replace("everyone edits", "server two"), base.replace("everyone edits", "mine two"));

  await page.goto("/notes");
  const region = page.getByRole("region", { name: "Note conflicts" });
  await expect(region).toContainText("2 notes have two versions");

  // 1: merge both lines in the editor
  await region.getByRole("button", { name: /^Resolve SYNC11 plan one \(conflict/ }).click();
  const diff = region.getByRole("group", { name: "Differences, theirs to mine" });
  await expect(diff).toContainText("Only in theirs: the line server version");
  await expect(diff).toContainText("Only in mine: the line my version");
  await sweep(page, "sync11-note-resolver");
  await region.getByRole("button", { name: "Merge in the editor" }).click();
  await region.getByLabel("Merged note text").fill("# Plan\n\nserver version and my version\n\nend\n");
  await region.getByRole("button", { name: "Save merged note" }).click();
  await expect(region.getByRole("status")).toContainText("The merged text is saved");
  const saved = await json<{ content: string }>(await page.request.get(`/api/notes/${first}`), 200);
  expect(saved.content).toBe("# Plan\n\nserver version and my version\n\nend\n");
  await expect(region).toContainText("1 note has two versions");

  // 2: keep mine
  await region.getByRole("button", { name: /^Resolve SYNC11 plan two \(conflict/ }).click();
  await region.getByRole("button", { name: "Keep mine" }).click();
  await expect(region.getByRole("status")).toContainText("Your version is now the note");
  const mine = await json<{ content: string }>(await page.request.get(`/api/notes/${second}`), 200);
  expect(mine.content).toContain("mine two");
  await expect(region.getByRole("button", { name: /^Resolve/ })).toHaveCount(0);

  // no copy is left behind: the list holds the two notes and nothing named "(conflict ...)"
  const list = await json<{ notes: { path: string }[] }>(await page.request.get("/api/notes"), 200);
  expect(list.notes.filter((n) => n.path.includes("SYNC11") && n.path.includes("(conflict"))).toEqual([]);
});

test("Settings shows the instant-updates status and a local test notification (SYNC-11b)", async ({ page, context }) => {
  test.setTimeout(180_000);
  await ensureOwner(page);
  await page.goto("/settings/notifications");
  const group = page.getByRole("region", { name: "Instant updates" });
  await expect(group.getByText("Not used in a browser")).toBeVisible();
  await expect(group.getByText("Notifications on this device")).toBeVisible();
  const testButton = group.getByRole("button", { name: "Show a test notification" });
  // headless Chromium has not been asked yet: the button waits for permission and says so
  await expect(group.getByText(/Not asked yet|Blocked|Not available on this server/)).toBeVisible();
  await sweep(page, "sync11-instant");

  // headless Chromium cannot be granted the permission: stand in for the Notification API and watch what the page asks for
  await context.addInitScript(() => {
    const shown: string[] = [];
    (window as unknown as { __shown: string[] }).__shown = shown;
    (window as unknown as { Notification: unknown }).Notification = Object.assign(
      function Notification(title: string) {
        shown.push(title);
      },
      { permission: "granted", requestPermission: async () => "granted" },
    );
  });
  await page.reload();
  await expect(testButton).toBeEnabled();
  await testButton.click();
  await expect(group.getByRole("status")).toContainText(/test notification was sent/);
  expect(await page.evaluate(() => (window as unknown as { __shown: string[] }).__shown)).toEqual(["Atlas test notification"]);
});
