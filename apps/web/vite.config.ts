import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

// The API the dev server proxies to. Defaults to the local API on :8000; the real-stack journey
// harness (MU-00, `playwright.real.config.ts`) points it at a throwaway API on a free port.
const apiTarget = process.env.ATLAS_API_PROXY_TARGET ?? "http://localhost:8000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": apiTarget,
      "/health": apiTarget,
    },
  },
  test: {
    // Two projects: the web app (jsdom) and the framework-free sync core (plain node, so a
    // stray `window`/`document` in `packages/sync-core` fails there instead of passing in jsdom).
    projects: [
      {
        extends: true,
        test: {
          name: "web",
          environment: "jsdom",
          globals: true,
          setupFiles: "./src/test/setup.ts",
          css: false,
          env: { NODE_ENV: "test" },
          // The Playwright E2E specs live in `e2e/` and must not be picked up by Vitest (M7-06).
          exclude: [...configDefaults.exclude, "e2e/**", "e2e-real/**"],
        },
      },
      {
        extends: true,
        test: {
          name: "sync-core",
          environment: "node",
          globals: true,
          include: ["../../packages/sync-core/{src,sim}/**/*.test.ts"],
          exclude: [...configDefaults.exclude, "../../packages/sync-core/sim/real/**"],
          testTimeout: 60_000,
        },
      },
      {
        // The framework-free device scheduler (M8-04b): plain node on a fake clock, like sync-core.
        extends: true,
        test: {
          name: "reminder-core",
          environment: "node",
          globals: true,
          include: ["../../packages/reminder-core/{src,sim}/**/*.test.ts"],
          exclude: [...configDefaults.exclude],
          testTimeout: 60_000,
        },
      },
      {
        // Opt-in conformance run against the real API (`ATLAS_SYNC_REAL=1`; its tests skip otherwise).
        extends: true,
        test: {
          name: "sync-core-real",
          environment: "node",
          globals: true,
          include: ["../../packages/sync-core/sim/real/**/*.test.ts"],
          testTimeout: 600_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
