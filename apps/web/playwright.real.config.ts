import { defineConfig, devices } from "@playwright/test";

/**
 * Real-stack journey configuration (MU-00, ADR-0043).
 *
 * Unlike `playwright.config.ts` (mocked API), these specs run against the **real** FastAPI app
 * (started from `services/api`) and a **fresh, throwaway PostgreSQL database** created and dropped
 * by `e2e-real/global-setup.ts`. Run with `npm run test:e2e:real`; see `docs/TESTING.md` §1b.
 *
 * Ports are chosen at run time, so the base URL is supplied to the tests through
 * `ATLAS_E2E_BASE_URL` (see `e2e-real/fixtures.ts`) rather than a static `baseURL`.
 */
export default defineConfig({
  testDir: "./e2e-real",
  testMatch: "**/*.spec.ts",
  globalSetup: "./e2e-real/global-setup.ts",
  // One database and one owner per run: journeys share state, so run them serially.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"]],
  use: { trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
