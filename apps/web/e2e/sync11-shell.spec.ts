import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { USER } from "./helpers";

/**
 * SYNC-11c screens as the desktop shell shows them, in a real browser with the HTTP API mocked and
 * `window.atlasDesktop` replaced by a fake bridge (the page cannot tell: it only feature-detects the
 * object). Covers the halt screens (restore confirmation with its two choices, update required, signed
 * out), Settings > Sync fed by the engine (a text conflict kept as a problem), and the Changes page fed
 * by the engine with an undo. Axe and overflow at 360/390/768/1440 px in both themes; `SYNC11_SHOTS=<dir>`
 * writes screenshots. The real app (Tauri, SQLite, the real server) is covered by `apps/desktop/e2e/run.mjs`.
 */
// The axe sweeps are CPU heavy: one worker for this file, so they do not starve the timing-sensitive specs that run beside it.
test.describe.configure({ mode: "serial" });

const SHOTS = process.env.SYNC11_SHOTS;
const WIDTHS = [360, 390, 768, 1440] as const;

async function sweep(page: Page, label: string) {
  const found: string[] = [];
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
    await page.waitForTimeout(300);
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]).analyze();
      for (const v of result.violations) found.push(`${label} ${theme} ${width}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 0) found.push(`${label} ${theme} ${width}: horizontal overflow ${overflow}px`);
      if (SHOTS && (width === 390 || width === 1440)) {
        mkdirSync(SHOTS, { recursive: true });
        await page.screenshot({ path: path.join(SHOTS, `${label}-${width === 390 ? "phone" : "desktop"}-${theme}.png`) });
      }
    }
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  expect(found, found.join("\n")).toEqual([]);
}

interface Controls {
  snapshot?: Record<string, unknown>;
  problems?: unknown[];
  resolutions?: unknown[];
  undo?: unknown;
}

/** Install the fake shell bridge before any page script runs, and the minimal API the shell UI needs. */
async function installShell(page: Page, controls: Controls) {
  await page.route("**/api/setup/status", (route) => route.fulfill({ json: { setup_required: false } }));
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: USER }));
  await page.route("**/api/tasks**", (route) => route.fulfill({ json: { tasks: [], total: 0 } }));
  await page.route("**/api/notes**", (route) => route.fulfill({ json: { notes: [], folders: [] } }));
  await page.route("**/api/projects**", (route) => route.fulfill({ json: { projects: [] } }));
  await page.route("**/api/calendar/**", (route) => route.fulfill({ status: 403, json: { error: "forbidden_scope" } }));
  await page.route("**/api/devices/current/hint", (route) =>
    route.fulfill({ json: { enabled: false, registered: false, failures: 0, invalid: false } }),
  );
  await page.addInitScript((c) => {
    const w = window as unknown as Record<string, unknown>;
    const calls: string[] = [];
    w["__calls"] = calls;
    const base = {
      phase: "running",
      reason: null,
      session: { signedIn: true, baseUrl: "https://atlas.example.org", device: { id: "d-me", name: "Kim's desktop" }, keystoreError: null },
      sync: { state: "idle", halt: null, pending: 0, failed: 0, conflicts: 0, lastSyncAt: Date.now() - 60_000, online: true, cursor: 12 },
      notes: null,
      settings: { remindersEnabled: true, contentMode: "full", closeToTray: true, autostartAsked: true },
      live: true,
      lastHintAt: Date.now() - 30_000,
      notificationPermission: "granted",
    };
    const snap = { ...base, ...(c.snapshot ?? {}) };
    w["atlasDesktop"] = {
      fetch: (p: string, init?: RequestInit) => fetch(p, { ...init, credentials: "include" }),
      snapshot: async () => snap,
      subscribe: () => () => undefined,
      info: async () => ({ version: "0.1.0", os: "linux", autostart: false, updater: "not_configured" }),
      syncNow: async () => {
        calls.push("syncNow");
      },
      sync: {
        resolutions: async () => c.resolutions ?? [],
        problems: async () => c.problems ?? [],
        dismissProblem: async (id: string) => void calls.push(`dismiss ${id}`),
        undo: async (id: string) => {
          calls.push(`undo ${id}`);
          return c.undo ?? { status: 200, body: { applied: true } };
        },
        confirmRestore: async () => void calls.push("confirmRestore"),
        discardLocal: async () => void calls.push("discardLocal"),
        resolveText: async (id: string, field: string, text: string) => void calls.push(`resolveText ${id} ${field} ${text}`),
        resumeAfterUpdate: async () => void calls.push("resumeAfterUpdate"),
      },
    };
  }, controls);
}

const calls = (page: Page) => page.evaluate(() => (window as unknown as { __calls: string[] }).__calls);

function halted(halt: unknown, pending = 3) {
  return { sync: { state: (halt as { kind: string }).kind, halt, pending, failed: 0, conflicts: 0, lastSyncAt: null, online: true, cursor: 40 } };
}

test("restore confirmation: both choices, never automatic, discard asks twice", async ({ page }) => {
  test.setTimeout(180_000);
  await installShell(page, {
    snapshot: halted({ kind: "restore_confirmation", reason: "cursor_ahead", epoch: null, head: 12 }),
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "The server was restored from a backup" })).toBeVisible();
  await expect(page.getByText("change 12")).toBeVisible();
  await expect(page.getByText("Unsent changes on this device")).toBeVisible();
  expect(await calls(page)).toEqual([]); // nothing happened by itself
  await sweep(page, "sync11-restore");

  await page.getByRole("button", { name: "Discard local changes and re-download" }).click();
  await expect(page.getByRole("group", { name: "Confirm discarding local changes" })).toBeVisible();
  expect(await calls(page)).toEqual([]);
  await sweep(page, "sync11-restore-confirm");
  await page.getByRole("button", { name: "Go back" }).click();
  await page.getByRole("button", { name: "Re-upload my local data" }).click();
  await expect.poll(() => calls(page)).toEqual(["confirmRestore"]);
});

test("update required and signed out are full-screen explanations with one action", async ({ page }) => {
  test.setTimeout(180_000);
  await installShell(page, { snapshot: halted({ kind: "update_required", min: 1, max: 1 }, 0) });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Atlas needs to be updated" })).toBeVisible();
  await sweep(page, "sync11-update-required");
  await page.getByRole("button", { name: "Check again" }).click();
  await expect.poll(() => calls(page)).toEqual(["resumeAfterUpdate"]);

  const second = await page.context().newPage();
  await installShell(second, { snapshot: halted({ kind: "signed_out", code: "token_revoked" }, 2) });
  await second.goto("/");
  await expect(second.getByRole("heading", { name: "This device was signed out" })).toBeVisible();
  await expect(second.getByRole("button", { name: "Sign in again" })).toBeVisible();
  await sweep(second, "sync11-signed-out");
});

test("Settings > Sync shows the engine's state and settles a text conflict with a normal edit", async ({ page }) => {
  test.setTimeout(180_000);
  await installShell(page, {
    snapshot: { sync: { state: "idle", halt: null, pending: 2, failed: 0, conflicts: 1, lastSyncAt: Date.now() - 120_000, online: true, cursor: 12 } },
    problems: [
      {
        id: "p1", kind: "conflict", reason: "conflict", status: 409, code: "conflict", action: "patch", entityType: "task", entityId: "t1", at: Date.now(),
        detail: null, copy: null, conflicts: [{ field: "title", reason: "text_conflict", serverRevision: 2, theirs: "Buy oat milk", mine: "Buy milk today" }],
      },
    ],
  });
  await page.goto("/settings/sync");
  await expect(page.getByText("Up to date")).toBeVisible();
  const resolver = page.getByRole("group", { name: /Two versions of the title/ });
  await expect(resolver).toContainText("Buy milk today");
  await expect(resolver).toContainText("Buy oat milk");
  await sweep(page, "sync11-shell-sync");
  await resolver.getByRole("button", { name: "Edit merged title" }).click();
  await resolver.getByLabel("Merged title").fill("Buy oat milk today");
  await resolver.getByRole("button", { name: "Save merged title" }).click();
  await expect.poll(() => calls(page)).toEqual(["resolveText p1 title Buy oat milk today"]);
});

test("the Changes page in the shell is fed by the engine; an offline undo is queued, not lost", async ({ page }) => {
  test.setTimeout(180_000);
  const entry = {
    id: "r1", entity_type: "task", entity_id: "t1", rule: "simple_later_wins", field: "priority", kept_revision: 4, has_loser: true, loser: "high",
    detail: null, device_id: "d-other", undoes_id: null, undone_at: null, undone_by: null, created_at: new Date(Date.now() - 300_000).toISOString(),
    undoable: true, undo_blocked: null, follow_up: null,
  };
  await installShell(page, { resolutions: [entry], undo: { queued: true } });
  await page.route("**/api/tasks/t1", (route) => route.fulfill({ json: { id: "t1", title: "Pay rent" } }));
  await page.goto("/");
  const banner = page.getByRole("region", { name: "Changed on another device" });
  await expect(banner).toContainText("1 change was made on another device");
  await banner.getByRole("link", { name: "Review" }).click();
  const card = page.getByRole("listitem").filter({ hasText: "another device" }).first();
  await expect(card).toContainText("Replaced priority");
  await card.getByRole("button", { name: /Undo the change to the priority of Pay rent/ }).click();
  await expect(card.getByRole("status")).toContainText("saved and will be tried when the connection returns");
  expect(await calls(page)).toEqual(["undo r1"]);
  await sweep(page, "sync11-shell-changes");
});

test("Settings > Desktop app shows live-connection, last hint and the server gateway status (SYNC-11b)", async ({ page }) => {
  test.setTimeout(180_000);
  await installShell(page, {});
  await page.goto("/settings/desktop");
  const group = page.getByRole("region", { name: "Instant updates" });
  await expect(group.getByText("Connected")).toBeVisible();
  await expect(group.getByText(/seconds? ago|now/)).toBeVisible();
  await expect(group.getByText("Not configured")).toBeVisible();
  await sweep(page, "sync11-shell-instant");
});
