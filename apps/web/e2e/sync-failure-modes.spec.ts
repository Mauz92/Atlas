import { expect, test } from "@playwright/test";

import {
  installApiMocks,
  overallBadge,
  queueBadge,
  queuedUpdate,
  seedOfflineQueue,
} from "./helpers";

/**
 * M7-06 failure-mode E2E suite (real browser, deterministic).
 *
 * Each test drives the real `/sync` UI in Chromium with the API mocked (see `helpers.ts`). The three
 * failure modes the M7 gate must survive are covered:
 *
 *   1. **Network loss** — a queued edit is retained while the connection is down and drains on reconnect.
 *   2. **Restart** — a queued edit survives a full page reload (a fresh JS context over the same
 *      durable device storage) and still syncs afterwards.
 *   3. **Stale client / conflict** — a mutation rejected with a stale-revision `409` is surfaced
 *      (the local edit is kept, never clobbered) and both resolutions behave as documented:
 *      *Keep mine* re-sends against the server's revision and lands; *Take server* discards the local
 *      edit without ever writing it.
 *
 * The queue's own badge is re-read from the durable store by the page's "Refresh" action; a flush is
 * confirmed against the intercepted requests (the real network effect) and then reflected in the UI,
 * so the assertions never depend on incidental render timing.
 */
test.describe("offline & sync failure modes (real UI, mocked API)", () => {
  test("network loss: a queued edit is kept while offline, then flushes when the connection returns", async ({
    page,
  }) => {
    const api = await installApiMocks(page);
    await page.goto("/sync");
    await expect(queueBadge(page)).toHaveText("All synced");

    // The state an offline edit leaves behind: one pending operation in the durable queue.
    await seedOfflineQueue(page, [queuedUpdate()]);
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(queueBadge(page)).toHaveText("Pending sync");
    await expect(page.getByText("1 change waiting to sync.")).toBeVisible();
    await expect(page.getByText("Update task")).toBeVisible();

    // Lose the connection: the replay attempt fails, so the queued edit must survive untouched.
    api.offline = true;
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    await expect(overallBadge(page)).toHaveText("Offline");
    await page.getByRole("button", { name: "Sync now" }).click();
    await expect(queueBadge(page)).toHaveText("Pending sync");
    expect(api.successfulWrites).toHaveLength(0);

    // Reconnect: the browser fires `online`, the app replays the queue and the edit reaches the server.
    api.offline = false;
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(() => api.successfulWrites.length).toBe(1);
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(queueBadge(page)).toHaveText("All synced");
    await expect(overallBadge(page)).toHaveText("Up to date");
    expect(api.successfulWrites[0].baseRevision).toBe(1);
  });

  test("restart: a queued edit survives a page reload and still syncs", async ({ page }) => {
    const api = await installApiMocks(page);
    api.offline = true; // still offline across the reload
    await page.goto("/sync");
    await expect(queueBadge(page)).toHaveText("All synced");

    await seedOfflineQueue(page, [queuedUpdate()]);
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(queueBadge(page)).toHaveText("Pending sync");

    // Reload: a brand-new JS context over the same durable device storage. The queued edit must
    // persist (and the reload's own reconcile attempt fails, so it is still pending afterwards).
    await page.reload();
    await expect(queueBadge(page)).toHaveText("Pending sync");
    await expect(page.getByText("Update task")).toBeVisible();

    // Wait for the reload's reconcile attempt to settle before reconnecting (its button is disabled
    // while a pass is in flight), so going online reliably starts a fresh pass.
    await expect(page.getByRole("button", { name: "Sync now" })).toBeEnabled();

    // Back online: the surviving edit is replayed and drains from the queue.
    api.offline = false;
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(() => api.successfulWrites.length).toBe(1);
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(queueBadge(page)).toHaveText("All synced");
  });

  test("stale client: a 409 conflict is surfaced and 'Keep mine' re-sends against the server revision", async ({
    page,
  }) => {
    const api = await installApiMocks(page);
    api.serverRevision = 5; // the server moved on; our queued edit (based on revision 1) is stale
    await page.goto("/sync");
    await expect(queueBadge(page)).toHaveText("All synced");

    await seedOfflineQueue(page, [queuedUpdate()]);
    await page.getByRole("button", { name: "Refresh" }).click();
    await page.getByRole("button", { name: "Sync now" }).click();

    // The conflict is surfaced and the local edit is kept — the server is never silently clobbered.
    await expect(page.getByRole("heading", { name: "Sync conflicts" })).toBeVisible();
    await expect(page.getByText("task task-1")).toBeVisible();
    await expect(page.getByText(/revision 5/)).toBeVisible();
    await expect(queueBadge(page)).toHaveText("Sync conflict");
    expect(api.successfulWrites).toHaveLength(0);

    // "Keep mine": re-queue the kept edit against the server's revision, then replay it — it lands.
    await page.getByRole("button", { name: "Keep mine" }).click();
    await expect(page.getByRole("heading", { name: "Sync conflicts" })).toHaveCount(0);
    await expect(queueBadge(page)).toHaveText("All synced");
    expect(api.successfulWrites).toHaveLength(1);
    expect(api.successfulWrites[0].baseRevision).toBe(5);
  });

  test("stale client: 'Take server' discards the local edit and adopts the server version", async ({
    page,
  }) => {
    const api = await installApiMocks(page);
    api.serverRevision = 5;
    await page.goto("/sync");
    await expect(queueBadge(page)).toHaveText("All synced");

    await seedOfflineQueue(page, [queuedUpdate()]);
    await page.getByRole("button", { name: "Refresh" }).click();
    await page.getByRole("button", { name: "Sync now" }).click();
    await expect(page.getByRole("heading", { name: "Sync conflicts" })).toBeVisible();

    await page.getByRole("button", { name: "Take server" }).click();
    await expect(page.getByRole("heading", { name: "Sync conflicts" })).toHaveCount(0);
    await expect(queueBadge(page)).toHaveText("All synced");
    await expect(page.getByText("Update task")).toHaveCount(0);
    // The local edit was discarded, never written: the server was not clobbered.
    expect(api.successfulWrites).toHaveLength(0);
  });
});
