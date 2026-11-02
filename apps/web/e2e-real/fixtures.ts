import { test as base, expect } from "@playwright/test";

/** `test` whose `baseURL` is the per-run Vite server started by `global-setup.ts`. */
export const test = base.extend({
  // Playwright fixtures take a destructured first argument and a `use` callback; the React-hooks
  // lint rule mistakes `use` for a hook.
  /* eslint-disable react-hooks/rules-of-hooks, no-empty-pattern */
  baseURL: async ({}, use) => {
    const url = process.env.ATLAS_E2E_BASE_URL;
    if (!url)
      throw new Error(
        "ATLAS_E2E_BASE_URL is not set — global setup did not run",
      );
    await use(url);
  },
  /* eslint-enable react-hooks/rules-of-hooks, no-empty-pattern */
});

export { expect };
