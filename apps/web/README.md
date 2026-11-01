# apps/web — React + TypeScript client (PWA)

The browser/PWA client: React + TypeScript, API types generated from the backend OpenAPI schema,
CodeMirror 6 for Markdown editing, and Web Push (VAPID) for desktop notifications.

What the app does today (delivered routes, and what is still a placeholder) is in
[`../../docs/USER_GUIDE.md`](../../docs/USER_GUIDE.md); the architecture is in
[`../../docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) §8.

## Scripts

- `npm run dev` — dev server on `:5173`, proxying `/api` to the backend on `:8000`.
- `npm run build` — type-check and production build.
- `npm run gen:api` — regenerate `src/api/schema.d.ts` from `../../services/api/openapi.json` (the
  generated file is committed; CI fails if it is out of date).
- `npm run lint` / `npm run typecheck` / `npm run test` — ESLint, `tsc --noEmit`, Vitest.
- `npm run e2e` — Playwright browser tests (Chromium); run `npx playwright install chromium` once
  first. This is a **separate** command and is not part of `scripts/verify.sh` — see
  [`../../docs/TESTING.md`](../../docs/TESTING.md) §1a.
