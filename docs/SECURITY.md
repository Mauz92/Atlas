# Atlas — Security

**Status:** Draft for approval (Milestone 0)
**Last updated:** 2026-10-27

Security is part of the architecture, reviewed at every milestone. Being self-hosted is **not**
a security property. This document defines the threat model and the controls Atlas targets.

---

## 1. Trust Model

- The **server** (and its database, volumes and encryption key) is trusted.
- The **notes directory** contents are **untrusted input** (a user or another tool may write
  arbitrary Markdown/HTML).
- **Clients** are mostly trusted but must never be the authority for authorisation or business
  rules; server-side validation is mandatory.
- **External providers** (Google, Microsoft) are untrusted for content and must be treated as
  authoritative only for the data they own.

## 2. Threat Model

| # | Threat | Control |
|---|---|---|
| T1 | Compromised browser session | HttpOnly/Secure/SameSite cookies, short session lifetime, session revocation, CSRF tokens, rate limiting |
| T2 | Stolen OAuth token | Encrypt tokens at rest; narrow scopes; revoke on disconnect; never log tokens |
| T3 | Malicious Markdown / links | Sanitise rendered HTML; block script execution; safe external link handling; no raw HTML by default |
| T4 | Path traversal | Resolve and confine all paths to the notes root; reject `..`; do not follow symlinks outside root |
| T5 | SQL injection | Parameterised queries via the ORM only; no string-built SQL |
| T6 | Cross-site scripting | Escape output; sanitise Markdown rendering; strict Content-Security-Policy |
| T7 | Unauthorised API access | Authenticate + authorise every protected endpoint server-side; no anonymous data endpoints |
| T8 | Compromised dependency | Pinned deps; automated advisories/scanning; respond to findings |
| T9 | Accidental public exposure | Only `web`/`api` exposed; `db`/`worker` private; HTTPS required; documented proxy config |
| T10 | Corrupted/incomplete backups | Back up DB **and** Markdown; integrity check; tested restore |
| T11 | Malicious/compromised client | Server-side validation; revision checks; idempotency keys; authorisation per request |
| T12 | Work data on unauthorised server | Disclose data flows; require acknowledgement before connecting a work account |

## 3. Authentication and Authorisation

- Maintained authentication only (no custom crypto/protocols) — ADR-0011.
- Passwords hashed with **Argon2id**; parameters recorded.
- Server-side sessions with HttpOnly, Secure, SameSite cookies; explicit revocation.
- CSRF protection on state-changing requests; auth endpoints rate-limited.
- Optional OIDC via Authlib for users who prefer an identity provider.
- Authorisation enforced on the server for **every** protected operation; clients are never the
  authority.
- **Password change (MU-08, ADR-0050).** `POST /api/auth/password` requires the current password,
  enforces the 12-character minimum, is CSRF-protected and rate limited per account with the login
  budget, revokes **all** the account's sessions and issues a fresh one to the caller. Passwords are
  never logged and validation errors on every `/api/auth/*` path omit the submitted value. The
  limiter is in-process (single-process deployment, as for login). Verified by
  `tests/integration/test_account_settings.py` and the J7 journey.
- `GET /api/instance` is authenticated and returns version, migration revision and backup counts only
  (no paths, connection strings, keys or job error text).

## 4. Secrets Management

- `.env.example` contains placeholders only; real `.env` is git-ignored.
- OAuth tokens encrypted at rest with a key stored outside the database (separate file/permission
  or OS keyring); key backed up separately.
- Secrets, tokens and note content redacted from logs and error responses.
- No secrets in browser bundles or mobile source.

## 5. Transport and Exposure

- HTTPS for all remote access; documented reverse-proxy configuration.
- PostgreSQL and worker ports are never published.
- Private-network-only deployment supported; remote access documented without requiring public
  exposure.
- Content-Security-Policy and other standard security headers set on the app.
- Dev stack on the tailnet (`scripts/dev-stack.sh`, `ATLAS_DEV_BIND`, see `DEPLOYMENT.md` §8a): a
  development-only exception to "HTTPS for all remote access". Threat: anyone on the tailnet (any
  device or shared node) or, if a LAN address is chosen, anyone on that LAN can reach a login page
  over plain HTTP, and credentials/session cookies cross the WireGuard-encrypted tailnet but are not
  TLS-protected on a LAN. Mitigations: only the Vite port binds to the chosen address, the API,
  worker and PostgreSQL stay on loopback; wildcard and public addresses are refused by the script;
  default stays loopback; authentication, CSRF and rate limits are unchanged; cookies are non-`Secure`
  only when `ATLAS_ENV=development`. Prefer the tailnet address over the LAN; use tailnet ACLs to
  restrict which devices may reach port 5173. Never funnel or port-forward it. This is not a
  production deployment path and uses the owner's dev data.

## 6. Notes and Content Safety

- Markdown treated as untrusted input (see `MARKDOWN_STORAGE.md`).
- Rendered preview sanitises HTML; unsafe HTML is escaped, not executed.
- External links opened safely; no automatic execution of note-embedded content.
- No plugin/script execution inside notes in the initial release.

## 7. Backups and Recovery (security aspects)

- Backups cover PostgreSQL and the Markdown root.
- Backup artifacts protected with appropriate file permissions; consider encryption at rest.
- A restore procedure exists and is **executed** as a test (M9), not merely documented.
- Backup integrity verified (e.g. checksum + restore into a scratch database).

## 8. Vulnerability Management

- Automated dependency scanning and advisory monitoring in CI.
- Pinned, reviewed dependencies with licence recorded (`DECISIONS.md`, M1-10).
- Security findings are never suppressed to achieve green CI.
- For security-sensitive changes, record threat, mitigation and verification.

## 9. Privacy

- No telemetry or analytics without explicit user approval and disclosure.
- No user content sent to external AI services.
- External dependencies (Google, Microsoft, and any push relay) disclosed in the UI before use.

## 10. Milestone Security Checklist

Applied at each milestone gate:

- [ ] Authorisation enforced server-side on new endpoints.
- [ ] All external input validated.
- [ ] No secrets logged or committed.
- [ ] New dependencies reviewed for licence/security.
- [ ] Backup coverage unaffected.
- [ ] Threat model updated if new surfaces were added.

---

## 11. Milestone 1 Security Baseline Review (2026-10-20)

Reviewed the §2 threat model against the M1 implementation. Evidence is test names and
commands recorded in `ACCEPTANCE.md`.

| Threat | Applicability at M1 | Control / evidence | Status |
|---|---|---|---|
| T1 Compromised browser session | Applicable | HttpOnly + SameSite=Lax session cookie (`test_session_cookie_is_httponly_and_samesite`), server-side sessions with expiry, explicit revocation on logout (`test_logout_revokes_session`), CSRF on unsafe requests (`test_csrf_required_for_authenticated_writes`) | Controlled |
| T2 Stolen OAuth token | Deferred to M5 | No OAuth credentials stored yet; token encryption key setting exists | N/A at M1 |
| T3 Malicious Markdown / links | Deferred to M2 | No note content handled yet | N/A at M1 |
| T4 Path traversal | Deferred to M2 | No filesystem access yet | N/A at M1 |
| T5 SQL injection | Applicable | ORM/parameterised access only; the single raw statement is a static `SELECT 1` | Controlled |
| T6 Cross-site scripting | Partially applicable | CSP header on all responses; no HTML rendering yet (M2 editor) | Controlled (revisit M2) |
| T7 Unauthorised API access | Applicable | Every data endpoint requires a session (`test_me_requires_authentication`); live check → 401 | Controlled |
| T8 Compromised dependency | Applicable | `npm audit` and `pip-audit` clean; both run in CI | Controlled |
| T9 Accidental exposure | Partially applicable | `db` published to loopback only, `worker` unpublished, HSTS in production, interactive API docs disabled in production, host-header allow-list available (`ALLOWED_HOSTS`) | Controlled |
| T10 Corrupted backups | Deferred to M9 | — | Not yet |
| T11 Malicious client | Applicable | Pydantic validation, CSRF, per-IP auth rate limiting, idempotency keys on the job queue | Controlled |
| T12 Work data on personal server | Deferred to M5 | Documented in PRODUCT_SPEC/CALENDAR_SYNC | Not yet |

### Findings fixed during this review

1. **Log redaction defect (high).** Top-level extra fields such as `refresh_token`,
   `password` and `authorization` were written to logs in clear text; only nested dicts were
   redacted. Fixed in `atlas/logging.py`; regression test `tests/unit/test_logging.py`.
2. **Login user-enumeration timing (medium).** An unknown email returned faster than a wrong
   password. Login now verifies against a dummy Argon2id hash before rejecting;
   `test_unknown_account_and_wrong_password_are_indistinguishable` also asserts identical
   bodies.
3. **Dependency advisories (high).** `npm audit` reported 2 critical + 1 moderate advisories
   (`tinypool` prototype-pollution → RCE, `@vitest/mocker` path traversal) reachable through
   `vitest`; `pip-audit` reported `pytest` PYSEC-2026-1845. Remediated by upgrading
   `vitest` → 5.0.5 and `pytest` → 9.1.1. Both audits are now clean and gated in CI.
4. **Interactive API docs in production (low).** `/api/docs` is now disabled when
   `ATLAS_ENV=production`.
5. **Cacheable API responses (low).** `Cache-Control: no-store` is set on `/api` responses.
6. **Host-header attacks (low).** Optional `ALLOWED_HOSTS` enables `TrustedHostMiddleware`
   (`test_trusted_host_rejects_unknown_host`).

### Residual risks and limitations (open)

- **R-SEC-1 — Rate limiting behind a proxy.** The limiter keys on `request.client.host`. Behind
  a reverse proxy every request appears to come from the proxy unless `X-Forwarded-For` is
  trusted, which we deliberately do not do yet. Mitigation: the reverse proxy must also
  rate-limit; a trusted-proxy configuration is deferred to the deployment-hardening work in
  M9. Risk accepted for M1 (single-user, private network).
- **R-SEC-2 — No account lockout or MFA.** Auth is password + session only. Mitigation: auth
  rate limiting; MFA/OIDC is available via ADR-0011 but not enabled by default.
- **R-SEC-3 — Symmetric key management.** **Resolved in M5-01** (`DECISIONS.md` ADR-0027):
  `TOKEN_ENCRYPTION_KEY` now protects stored OAuth credentials with AES-256-GCM (a maintained
  library), is held outside the database (never a column, an API response or a log) and each row
  records a `key_id` so keys can be rotated (`TOKEN_ENCRYPTION_KEY_ID` /
  `TOKEN_ENCRYPTION_PREVIOUS_KEYS`). Loss of the key makes credentials unreadable, so it must be
  backed up separately. There is no automatic re-encryption job yet — a rotation is applied on the
  next write to each row.
- **R-SEC-4 — Single-user model.** Roles/permissions are not modelled; authorisation is
  "authenticated or not". Sufficient for the target deployment; revisit if multi-user is
  approved.

**Conclusion.** All M1-applicable controls are implemented and verified by test or live check.
Deferred items (T2, T3, T4, T10, T12) belong to later milestones and are recorded here so they
are not mistaken for verified controls.

### Milestone 5 credential-store security note (2026-10-26)

M5-01 stores OAuth tokens at rest (`provider_credentials`), so the T2 control is now implemented and
tested rather than deferred.

| Threat (SECURITY §2) | Control | Evidence | Status |
|---|---|---|---|
| T2 Stolen OAuth token | Tokens sealed with **AES-256-GCM** (maintained `cryptography` library; no custom crypto) as one authenticated `ciphertext`, with associated data binding the blob to its `(user, provider)`; the key is held outside the DB and never logged or returned; a `key_id` per row supports rotation; tampering/unknown keys fail closed | `services/api/atlas/calendar/crypto.py`; `tests/unit/test_token_crypto.py`; `tests/integration/test_provider_credentials_api.py` (raw row is ciphertext; tamper → `500`; no token in responses or `422` bodies) | Controlled (M5-01) |
| T7 Unauthorised API access | Every credential endpoint requires a session and CSRF; the store is strictly user-scoped (another user's credential is a `404`/`NotFound`) | `tests/integration/test_provider_credentials_api.py::test_credentials_require_authentication`, `test_writes_require_csrf`, `test_credentials_are_strictly_user_scoped`, `test_service_rejects_cross_user_access` | Controlled (M5-01) |
| T8 Compromised dependency | `cryptography` reviewed (licence + advisories); bound to a version clear of known advisories | `docs/DEPENDENCIES.md`; `pip-audit` → no known vulnerabilities | Controlled (M5-01) |

Design rationale and the considered alternatives are in `DECISIONS.md` ADR-0027. The real provider
OAuth exchange is still unverified (M5-00 is `BLOCKED`, AR-001).

### Milestone 9 security review — threat model vs implementation (2026-10-27, M9-05)

This review walks the §2 threat model against the **delivered** implementation and its tests. Scope is
the delivered surface: M1 (auth/session/exposure), M2 (notes), M3/M4 (tasks/projects), M5-01/02/06/08/10
(credential store, adapter contract, projection, sync status, reconciliation), M7 (change feed + offline
sync), M8-01/02/03/05 (reminders, Web Push, device registry, preferences), and M9-01…M9-04
(backups, restore, export, dependency scan). **Not reviewed as live** (not delivered): M5-00 (real
accounts, `BLOCKED`/AR-001), M5-03/04 and M6 (real provider adapters/writes), M8-04 (mobile push).
Those surfaces are recorded, not treated as implemented.

**Result:** every applicable control is implemented server-side and evidenced by test, live check or
code inspection. One real gap was found and **fixed** (F1); its live effect was **confirmed on
2026-10-27** (M9-06: the rebuilt web image serves the headers — see below). Every other open item is an
accepted residual risk, listed below.

| # | Control (as asserted) | Implemented? | Evidence |
|---|---|---|---|
| T1 | HttpOnly/Secure/SameSite cookies; session expiry + revocation; CSRF; auth rate limiting | ✅ Yes | `atlas/api/auth.py` (`_set_session_cookies`: `httponly=True`, `samesite=lax`, `secure=is_production`; `logout` sets `revoked_at`), `atlas/api/deps.py` (expiry + `revoked_at IS NULL`), `atlas/middleware.py::CsrfMiddleware` + `atlas/auth/csrf.py` (signed, session-bound double-submit), `atlas/auth/ratelimit.py`. Tests: `test_security.py::test_session_cookie_is_httponly_and_samesite`, `test_auth_flow.py` (`logout_revokes_session`, `csrf_required_for_authenticated_writes`), `test_csrf.py` (4), `test_ratelimit.py`, `test_config.py::test_secure_cookies_only_in_production` |
| T2 | Encrypt OAuth tokens at rest; never log; never return; revoke on disconnect | ✅ Yes (store) | `atlas/calendar/crypto.py` (AES-256-GCM + HKDF; key outside the DB), `atlas/calendar/tokens.py` (`TokenBundle.__repr__` redacts), `atlas/api/calendar.py` (metadata-only responses), `atlas/main.py` (422 `input` stripped on `/api/calendar/credentials*`). Tests: `test_token_crypto.py`, `test_provider_credentials_api.py` (row is ciphertext; key not in the row; tamper → `500` without plaintext; no token in responses or `422`; previous-key rotation). Real provider exchange: `NOT RUN` (M5-00/AR-001) |
| T3 | Sanitise Markdown rendering; block scripts; safe links; no raw HTML execution | ✅ Yes | `apps/web/src/components/MarkdownPreview.tsx` (`marked` → `DOMPurify.sanitize`); it is the **only** `dangerouslySetInnerHTML` in the app (`grep`). Test: `MarkdownPreview.test.tsx` (script stripped, `onerror` removed, `javascript:` link removed) |
| T4 | Resolve/confine paths to the notes root; reject `..`; no symlink escape | ✅ Yes | `atlas/notes/storage.py::normalize_rel_path`/`absolute` (rejects absolute/`..`, `.atlas` reserved, `resolve()` + parents check), `delete` moves to trash. Tests: `test_note_paths.py` (incl. symlink-escape), `test_note_storage.py`, `test_notes_api.py::test_path_traversal_is_rejected` |
| T5 | Parameterised queries only; no string-built SQL | ✅ Yes | All access via SQLAlchemy ORM / bound `text()`; the only raw statements are static/bound (`SELECT 1`; `UPDATE users … WHERE id = :user_id RETURNING`). Search uses bound `ilike(..., escape="\\")` / `plainto_tsquery("english", :q)`. Tests: `test_tasks_filters.py::test_search_escapes_like_metacharacters` (+ injection-shaped payload), `test_task_filters.py::test_the_like_pattern_escapes_wildcards_and_the_escape_character` |
| T6 | Escape output; sanitise Markdown; **strict CSP** | ⚠️ Partly → **fixed (F1)** | API: `atlas/middleware.py` sets CSP + `X-Content-Type-Options`/`X-Frame-Options`/`Referrer-Policy` on responses (`test_health.py::test_security_headers_present`). The SPA document (served by nginx) carried **no** headers — **finding F1**, fixed in `apps/web/nginx.conf` |
| T7 | Authenticate + authorise every protected endpoint server-side; no anonymous data endpoints | ✅ Yes | Every data router depends on `CurrentUser`; only `/health`, `/health/ready`, `/api/setup/status`, `/api/auth/setup`, `/api/auth/login` are anonymous (the last two are the auth entry points, rate-limited). Tests: `test_*_require_authentication` for tasks, projects, project export, notes, note-links, changes, task-changes, calendar status/trigger, notifications, reminders, export |
| T8 | Pinned deps; scanning; respond to advisories; never suppress | ✅ Yes | M9-04: `pip-audit` → 0 over 91 pkgs; `npm audit` → 0 over 370 pkgs; CI gate fails on a finding (`docs/ACCEPTANCE.md` M9-04, `RISKS.md` R-17) |
| T9 | Only `web`/`api` exposed; `db`/`worker` private; HTTPS; documented proxy config | ✅ Config / operator-dependent | `deploy/docker-compose.yml` (`db` → `127.0.0.1:5432` only; `worker` publishes no port; `api`/`web` behind the proxy), HSTS + docs-disabled in production (`test_security.py::test_production_sets_hsts_and_disables_interactive_docs`, **added in this review**), `ALLOWED_HOSTS` (`test_trusted_host_rejects_unknown_host`). TLS termination itself is the operator's proxy (`DEPLOYMENT.md` §8) → `NOT RUN` here |
| T10 | Back up DB **and** Markdown; integrity check; **tested** restore | ✅ Yes | M9-01/ADR-0041 (`atlas/backups/*`, `test_backups.py`, integration `test_backups.py`); M9-02 executed restore drill (`ACCEPTANCE.md`) |
| T11 | Server-side validation; revision checks; idempotency keys; per-request authz | ✅ Yes | Pydantic boundaries at every endpoint; `base_revision` optimistic concurrency (`409`); `Idempotency-Key` store (per-user, transactional); user-scoped services. Tests: `test_idempotency.py`, task/note revision tests, cross-user scoping tests |
| T12 | Disclose data flows; require acknowledgement before connecting a work account | ➖ Not delivered | Documented in `PRODUCT_SPEC.md`/`CALENDAR_SYNC.md`; the enforcing selection UI is M5-05 (not delivered) → `NOT RUN` |

#### Findings

**F1 — SPA document served without security headers or CSP (severity: Low; FIXED).**
The threat model (T6) and §5 assert a "strict Content-Security-Policy and other standard security
headers … on the app". `atlas/middleware.py` sets them, but that applies to `/api` responses only; the
application document and assets are served by nginx (`apps/web/nginx.conf`) and carried **no**
`Content-Security-Policy`, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` or
`Permissions-Policy`. The practical XSS exposure is limited (React escapes by default and the single
`dangerouslySetInnerHTML` path is DOMPurify-sanitised), so this is a defence-in-depth gap, not an
exploitable defect. **Remediation (fixed in this review):** `apps/web/nginx.conf` now sets those headers
on the SPA location (scoped so proxied `/api` responses keep the API's own headers), with a CSP sized
for the built app (`script-src 'self'`; `style-src 'self' 'unsafe-inline'` because CodeMirror injects
`<style>` elements). The header's live effect is **confirmed (`PASS`) on 2026-10-27 (M9-06)**: the web
image was rebuilt and the recreated container serves `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy` and the CSP on `/`, while
proxied `/api`/`/health` responses keep the API's own headers (scoping intact). Evidence in
`ACCEPTANCE.md` (M9-06).

**No other defect was found.** No finding was suppressed or downgraded to obtain a green result.

#### Residual risks and limitations (open)

- **R-SEC-1, R-SEC-2, R-SEC-4** (see §11 above) are unchanged and still accepted: rate limiting keys on
  `request.client.host` behind a proxy; no account lockout/MFA; single-user authorisation model.
- **R-SEC-3** is resolved (ADR-0027 encrypted credential store).
- **R-21 (new in this review, Low, accepted; `RISKS.md`).** A registered Web Push `endpoint` is bounded
  in length and shape but not constrained to an `https` push-service host, and a delivery targets it
  directly. In the target single-user deployment the registrant is the only account, so any effect is
  self-directed; accepted, but it should be revisited (scheme/host allow-list) if multi-user is ever
  approved.
- **Session lifetime.** The default session TTL is 14 days (`session_ttl_seconds`), longer than the
  "short session lifetime" the T1 row implies. Explicit revocation on logout exists; accepted for a
  single-user self-hosted deployment and configurable per operator.

#### Controls that could not be verified here (`NOT RUN`/`NOT DELIVERED`)

| Item | Status | Reason |
|---|---|---|
| TLS/HTTPS termination and the reverse-proxy config (T9) | `NOT RUN` | Terminated by the operator's proxy, outside this environment (`DEPLOYMENT.md` §8) |
| Real OAuth token exchange / provider sync (T2) | `NOT RUN` | M5-00 `BLOCKED` (AR-001); only the store is built/tested |
| Live effect of the SPA CSP/headers (F1) | `PASS` | Rebuilt web image + recreated container on 2026-10-27 (M9-06): `curl -I http://localhost:8081/` returns the headers/CSP. The browser rendering itself is not exercised by the harness |
| Work-account data-flow acknowledgement UI (T12) | `NOT DELIVERED` | Belongs to M5-05, which is not delivered |

See `ACCEPTANCE.md` (M9-05) for the exact commands and results.
