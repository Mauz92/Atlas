# Contributing to Atlas

Atlas is primarily developed by a single owner with an AI coding agent. This guide captures the
working rules so any session produces consistent, verifiable increments.

## Before you start

1. Read [`AGENTS.md`](AGENTS.md) (operating instructions) and the current milestone in
   [`docs/ROADMAP.md`](docs/ROADMAP.md).
2. Read the architecture and the decision records relevant to your task.
3. Inspect the working tree and current branch.
4. Pick the **smallest** useful task whose dependencies are satisfied.

## Ground rules

- One implementation task at a time. Respect milestone gates.
- No feature is "done" because code exists — acceptance criteria and tests must pass.
- Never silently discard user data (notes, tasks, calendar changes).
- Never commit secrets, tokens or real personal/work data.
- No custom cryptography or authentication protocols.
- Record consequential decisions in `docs/DECISIONS.md`; record risks in `docs/RISKS.md`.
- Do not weaken or disable tests to make a gate pass.

## Definition of Done for a task

- Acceptance criteria met and evidenced in [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md).
- Unit and integration tests added/updated and passing.
- Linting and type checking pass.
- Documentation updated where behaviour changed.
- `docs/CHANGELOG.md` updated for user-visible changes.
- Commits describe the intent of a coherent change.

## API contract changes

`apps/web/src/api/schema.d.ts` is generated from the backend OpenAPI schema and is **committed**
(clean builds depend on it). After changing any API schema, run:

```bash
cd apps/web && npm run gen:api
```

CI regenerates it and fails if the committed file is out of date, so commit the regenerated file
with your change.

## Branching and commits

- Use small, logically coherent changes.
- Commit messages describe intent.
- Do not force-push, rewrite shared history, or publish releases without explicit approval.
- Do not commit unless requested or explicitly authorised.

## Code conventions

- Keep business logic out of UI components.
- Keep provider-specific code inside calendar adapters.
- Use typed interfaces and explicit validation at boundaries.
- Prefer maintained libraries over custom implementations.
- Follow existing patterns; avoid unrelated refactoring.

## Licence of contributions

Atlas is MIT-licensed ([`LICENSE`](LICENSE), ADR-0080). By submitting a contribution you agree that it is
licensed under the same terms. Pull requests from forks do not run CI automatically (the CI runs on the owner's
own machine); a maintainer will push the branch to this repository to run it.
