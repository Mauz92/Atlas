import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8000",
      "/health": "http://localhost:8000",
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: "./src/test/setup.ts",
    css: false,
    env: { NODE_ENV: "test" },
    // The Playwright E2E specs live in `e2e/` and must not be picked up by Vitest (M7-06).
    exclude: [...configDefaults.exclude, "e2e/**"],
  },
});
