# Atlas — Dependency and Licence Inventory

**Status:** Active (Milestone 1)
**Last updated:** 2026-10-20

Every dependency must permit the intended personal and professional use (REQ-003). Additions are
reviewed before introduction and recorded here with purpose and licence. Licence identifiers are
as reported by the package metadata; verify against the upstream project before a release.

## Runtime — backend (`services/api`)

| Package | Purpose | Licence | Notes |
|---|---|---|---|
| fastapi | HTTP API framework | MIT | |
| uvicorn[standard] | ASGI server | BSD-3-Clause | |
| pydantic | Validation / settings models | MIT | |
| pydantic-settings | Env-based configuration | MIT | |
| email-validator | Email address validation (Pydantic) | CC0-1.0 | |
| sqlalchemy | ORM / Core | MIT | 2.x async |
| alembic | Schema migrations | MIT | |
| psycopg[binary] | PostgreSQL driver (sync + async) | LGPL-3.0 | Used as an unmodified library dependency; no distribution obligation triggered |
| argon2-cffi | Password hashing (Argon2id) | MIT | |
| itsdangerous | Signed tokens (CSRF) | BSD-3-Clause | |
| python-multipart | Form parsing | Apache-2.0 | |

## Runtime — frontend (`apps/web`)

| Package | Purpose | Licence | Notes |
|---|---|---|---|
| react, react-dom | UI runtime | MIT | |
| react-router-dom | Client routing | MIT | |
| vite | Build tool / dev server | MIT | |
| typescript | Type checking | Apache-2.0 | |
| codemirror (+ @codemirror/*) | Markdown source editor | MIT | Lazy-loaded on the notes route |
| marked | Markdown → HTML rendering | MIT | |
| dompurify | HTML sanitisation of rendered notes | MPL-2.0 OR Apache-2.0 | Untrusted content (SECURITY T3/T6) |

## Development / CI

| Package | Purpose | Licence |
|---|---|---|
| pytest, pytest-asyncio | Test runner | MIT / Apache-2.0 |
| httpx | Test HTTP client | BSD-3-Clause |
| ruff | Lint + format | MIT |
| mypy | Static type checking | MIT |
| pip-audit | Python advisory scanning (CI) | Apache-2.0 |
| npm audit | JS advisory scanning (CI, built in) | — |
| openapi-typescript | Generate TS types from OpenAPI | MIT |
| vitest, jsdom, @testing-library/react | Frontend unit tests | MIT |
| eslint, typescript-eslint | Frontend linting | MIT / BSD-2-Clause |
| @vitejs/plugin-react | Vite React plugin | MIT |
| playwright | End-to-end tests (M7+) | Apache-2.0 |

## External services / platform costs (not software dependencies)

| Item | Cost | Notes |
|---|---|---|
| Google Calendar API | Free (quota-limited) | ADR-0009 |
| Microsoft Graph | Free (throttled) | ADR-0009 |
| Firebase Cloud Messaging (Android push) | Free | ADR-0007 |
| APNs / iOS delivery | **Apple Developer Program (annual fee)** | ADR-0007, PRODUCT_SPEC §3.1 |
| PostgreSQL, Docker, reverse proxy | Self-hosted (existing infra) | |

## Decisions and rejections

- **Procrastinate** (Postgres task queue, MIT) — considered but not adopted in M1; upstream is
  seeking maintainers (RISKS R-05). A minimal in-repo `SKIP LOCKED` queue is used instead, behind
  the same `jobs` interface, so the choice is reversible (ADR-0005).
- **`vitest` 5** and **`pytest` 9** adopted during the M1 security review to clear known
  advisories (see `docs/SECURITY.md` §11). Both audits (`npm audit`, `pip-audit`) run in CI; a
  finding must be fixed or explicitly justified, never suppressed to green the build.
- Anything under a licence that would restrict self-hosted personal/commercial use, or that adds a
  mandatory paid service, is rejected.

## Verification

- Licences checked at introduction. Advisory scanning runs in CI on every push/PR. Full licence
  audit is part of Milestone 9 (task M9-04).
