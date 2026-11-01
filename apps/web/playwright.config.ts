import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright end-to-end configuration (M7-06).
 *
 * The failure-mode E2E suite drives the **real** Atlas UI (the `/sync` route and its
 * queue/reconciliation/conflict surfaces) in a real Chromium, with the HTTP API mocked through
 * Playwright's network interception so the run is deterministic and never depends on the live
 * backend or real calendar accounts (AGENTS.md §13: deterministic, isolated; §11: no real data).
 *
 * The app under test is the production build served by `vite preview` (a fresh `npm run build`
 * runs first), so the suite exercises the bundled client, not the dev server. This is a **separate**
 * command (`npm run e2e`); `scripts/verify.sh` is protected and does not run it — see `TESTING.md`.
 */
const PORT = 4173;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // A single, small matrix: Chromium only — enough to exercise the failure modes deterministically.
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], baseURL: BASE_URL },
    },
  ],
  webServer: {
    command: `npm run build && npm run preview -- --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
