# Atlas — Release Procedure (agent checklist)

**Status:** Active. Read this before every release; tick each step in order.
**Scope:** how to cut a version tag, what to update first, and how to update and verify the owner's server.
The release label and known limitations are in [`RELEASE.md`](RELEASE.md). The pipeline itself (images, desktop build,
host updater) is described in [`DEPLOYMENT.md`](DEPLOYMENT.md) §13. This file is the to-do list, not a second source of truth.

**Authority.** Committing, pushing, tagging and publishing are outward-facing (`AGENTS.md` §17, §18). Do each only when the
owner has asked for it in this session (for example "release 0.3.3"). Never force-push, move or delete a tag, or bypass hooks.
If a step fails, stop and report; do not work around it.

---

## 0. Decide the version

- [ ] Semantic Versioning: `PATCH` for fixes only, `MINOR` for user-visible additions, `MAJOR` only if the owner says so.
- [ ] The version comes **from the tag** (`vX.Y.Z`). No version file is bumped. `services/api/pyproject.toml` stays `0.1.0` on
      purpose; the API reports the tag because the image is built with `ATLAS_VERSION`.
- [ ] Look at what changed: `git log --oneline vPREVIOUS..HEAD` and `git status` (nothing uncommitted may ship by accident).

## 1. Update the documents (in the same commit as the last change)

Do all of these; if one does not apply, say so in the commit message rather than skipping silently.

- [ ] `docs/CHANGELOG.md`: add `## [X.Y.Z] — YYYY-MM-DD` above the previous version (turn "Unreleased" into the dated section).
      Group as **Added**, **Changed**, **Fixed**. Say what the user sees, name the setting or screen, mention operator-visible
      changes (new environment variables, migrations, API actions). Do not list work that only existed between two releases.
- [ ] `README.md`: the status badge (`status-X.Y.Z…`), the status note (`Status: X.Y.Z`), the "What you get" and "What works today"
      rows for anything new, and the "latest" version in the changelog sentence. Never describe an unreleased or unverified
      feature as available (`AGENTS.md` §2).
- [ ] `docs/RELEASE.md` §1 "Current release" line (version and date, and anything newly skipped or unverified).
- [ ] `docs/ROADMAP.md`: task rows moved to `DONE` with the version, only if their acceptance evidence exists.
- [ ] `docs/ACCEPTANCE.md`: a row per release with the CI run ids and what was and was not verified (use `PASS` / `FAIL` /
      `BLOCKED` / `NOT RUN`; never invent a result).
- [ ] `docs/USER_GUIDE.md` when a screen or setting changed; `docs/OPERATOR_GUIDE.md` / `docs/DEPLOYMENT.md` when an operator
      step, environment variable or migration changed.
- [ ] `docs/DECISIONS.md` for any architectural decision; `docs/DEPENDENCIES.md` for any added dependency, bundled font or licence
      notice; `docs/RISKS.md` for newly found risks.
- [ ] Dates are absolute (`2026-11-24`), not "today".

## 2. Verify locally (nothing here is optional unless it cannot run; then record `NOT RUN` and why)

- [ ] Backend, from `services/api`: `ruff check`, `ruff format --check`, `mypy`, and `TEST_DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test .venv/bin/python -m pytest -q`
      (about 9 minutes; never run two DB test processes at once, see the test-environment memory).
- [ ] Frontend, from `apps/web`: `npx eslint`, `npx tsc`, `npx vitest run`, `npm run build`, `node scripts/check-css-scale.mjs`.
- [ ] For UI changes: the relevant real-stack Playwright spec (`npx playwright test -c playwright.real.config.ts <spec>`), and look at
      the page at **phone width** as well as desktop. The 0.3.3 tab wrap was only found on a real phone.
- [ ] For a migration: confirm it applies to a copy of the live database (the server's own backup works) and read the downgrade.
- [ ] Report results with the actual numbers.

## 3. Commit and push `main`

- [ ] Review `git show --stat` of each commit for files that do not belong (see the first gotcha below).
- [ ] Small, coherent commits; commit message states intent; end with the attribution lines the session asks for.
- [ ] No secrets, personal notes, database dumps or real calendar data in the commit.
- [ ] `git push origin main`, then **wait for the CI run on that exact commit to finish green**: `gh run list --limit 3`,
      `gh run view <id>`. A queued run is not a pass. The self-hosted runner can queue for a long time; wait.
- [ ] If CI fails: read the failing job. A known flake (see §7) may be re-run once with `gh run rerun <id> --failed`; anything else is
      a real defect: fix it, do not tag.

## 4. Tag (needs the owner's go-ahead for this version)

- [ ] `git status` clean, on `main`, up to date with `origin/main`, and the tagged commit is the one CI passed.
- [ ] `git tag -a vX.Y.Z -m "vX.Y.Z: <one line>"` then `git push origin vX.Y.Z`. The tag must be on `main` (the workflow refuses
      anything else). Never reuse, move or delete a tag; if a release is wrong, cut the next patch.

## 5. Watch the Release workflow

- [ ] `gh run list` for the `Release` run on the tag. Jobs: version and guard rails, CI gate, server images (build, smoke test,
      push), Linux desktop (AppImage, `.deb`), Windows (experimental, normally skipped), GitHub Release. Expect roughly 1 hour.
- [ ] Confirm the assets: `gh release view vX.Y.Z` lists `atlas-deploy.tar.gz`, the AppImage, the `.deb` and `SHA256SUMS`.
      The release is published automatically (not left as a draft).
- [ ] If a job fails, read it, re-run the failed job once only if it is a known flake, otherwise fix on `main` and cut the next patch.

## 6. Update the owner's server (only when the owner asks)

The owner's server is reached over Tailscale; the host and login are in the owner's SSH setup (`~/.ssh/atlas_deploy` is the deploy
key). Ask if the host is not known. Use the key, not any password pasted into the chat.

- [ ] Check the disk first: `df -h /` on the server; if above 85%, `docker builder prune -af` (build cache only) before building.
- [ ] From a checkout **of the tag**: `ATLAS_DEPLOY_HOST=user@host ATLAS_DEPLOY_KEY=~/.ssh/atlas_deploy scripts/deploy-update.sh`.
      It backs up first, copies the code, rebuilds, restarts, and never touches `.env` or the certificates. It takes 10 to 20 minutes
      and exceeds a 10 minute tool timeout, so run it in the background.
- [ ] After a release with migrations the API can take **about two minutes** to become healthy and compose may leave the worker in
      `Created`. Wait for `atlas-api-1` to be `healthy`, then run `docker compose -p atlas --env-file .env -f deploy/docker-compose.yml up -d` again.
- [ ] Verify: all four containers up (`atlas-api-1` healthy), `curl localhost:8090/health/ready` returns `ready`, `alembic current` shows the
      expected head, the API's version is `X.Y.Z` (`python -c "import atlas; print(atlas.__version__)"` in the API container), and
      Settings > About shows it.
- [ ] Tell the owner that a phone or browser may show the old app until its service worker updates (close the tabs, reload), and that
      optional features (Settings > Plugins) and styles (Settings > Appearance) are off or per-browser by default.
- [ ] Rollback path if the new version does not start: restore the pre-update backup (`DEPLOYMENT.md` §7, `OPERATIONS.md` §2.7).

## 7. After the release

- [ ] Add the real CI and Release run ids and the server result to `docs/ACCEPTANCE.md`; fix any entry that said "pending".
- [ ] Open items found on the way (flaky tests, failed Dependabot runs, disk pressure) are recorded in `docs/RISKS.md` or reported.
- [ ] Report to the owner: version, what shipped, tests run with results, what is unverified, and the next recommended task
      (`AGENTS.md` §20).

## Known gotchas

- **Never commit a worktree shortcut.** `git status` and `git show --stat` before every commit: look for `node_modules`, `.env`, build output or a
  symlink. `.gitignore` now ignores `node_modules` as folder or link (v0.3.2 shipped a self-pointing `apps/web/node_modules` symlink by accident,
  and merging it replaced the real folder in the main checkout). If a worktree needs dependencies, run `npm ci` there instead of linking.

- **Flaky test:** `apps/web/e2e-real/ux08-settings-states.spec.ts` ("the heading did not move") failed once in a Release run and passed on
  the same code elsewhere. Re-run once; if it recurs, harden it (wait for the heading position to stay unchanged across two animation frames).
- **Light theme:** Playwright and axe run against whichever theme the browser reports, so a colour that only fails in light can pass on a dark local machine and fail in CI. When a colour changes, check both themes (see `src/ttrpg.test.ts`, `src/tavern.test.ts`).
- **Dependabot:** a failing "cargo in /spikes/tauri for glib" run on `main` is unrelated to the release; report it, do not block on it.
- **Windows job** is experimental and skipped by default; the Windows installer is not part of a release.
- **Source builds** (`scripts/deploy-update.sh`) take the version from `git describe`; run it from a checkout of the tag, or set `ATLAS_VERSION`.
- **Prettier / hooks:** commits run the repository hooks. Fix what they report; never bypass them.
- **Service worker:** the web app is cached by its service worker. "I can't see the new feature" is usually a stale tab, a feature that is
  off by default (TTRPG plugin) or a per-browser setting (Tavern style).
