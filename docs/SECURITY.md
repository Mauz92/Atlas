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
- **Password change (MU-08, ADR-0050; SYNC-06, ADR-0065).** `POST /api/auth/password` requires the current password,
  enforces the 12-character minimum, is CSRF-protected and rate limited per account with the login
  budget, revokes **all** the account's sessions and issues a fresh one to the caller; with `revoke_devices: true` it also
  signs out every sync device (default off). It is a browser-only endpoint: a device token gets `403`. Passwords are
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
| T7 | Authenticate + authorise every protected endpoint server-side; no anonymous data endpoints | ✅ Yes | Every data router depends on `CurrentUser`; only `/health`, `/health/ready`, `/api/setup/status`, `/api/auth/setup`, `/api/auth/login` (and, since AUTH-01, `/api/auth/recovery/reset`, authorised by the recovery code) are anonymous (the entry points are rate-limited). Tests: `test_*_require_authentication` for tasks, projects, project export, notes, note-links, changes, task-changes, calendar status/trigger, notifications, reminders, export |
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

## 12. Sync clients and device credentials (ADR-0059 D8, ADR-0065; protocol server SYNC-03, note merge SYNC-04, resolution log SYNC-05 and device credentials SYNC-06 implemented; native clients are SYNC-09/10)

Applies when local-first desktop/Android clients exist (ADR-0055). Design: `SYNC_PROTOCOL.md` §10.

| # | Threat | Control |
|---|---|---|
| T13 | Stolen or leaked device token | 256-bit random, shown once, only its SHA-256 stored (`devices.token_hash`); constant-time comparison; 24 h rotation grace that ends when the new token is first used; idle expiry (`CHANGE_RETENTION_DAYS`); list and revoke in Settings (immediate, tested); a password reset revokes all, a password change can; token held in the OS keystore and attached by native code, never exposed to the webview or logs (client side: SYNC-09). **Implemented (SYNC-06):** everything except the client keystore. A *currently* stolen token works until revoked (rotation does not detect reuse, R-52) |
| T14 | Lost/stolen laptop with local data | Atlas does not encrypt the local database or notes folder (ADR-0055 §6): OS disk encryption is the control; revoking the device stops sync; documented to the owner |
| T15 | Malicious or old client writing wrongly | Sync mode requires protocol version, idempotency key and base revision; unknown fields rejected; `426` outside the supported range; all rules server-side |
| T16 | Cross-user id collision with client-chosen UUIDs | `409 id_exists` for another user's id, indistinguishable from own-id mismatch; every query user-scoped |
| T17 | Sync as an exfiltration path (compromised token pulls everything) | Per-device rate limits keyed by device id (600 requests, 120 writes a minute; **implemented**), `last_seen_at`/device list visible (**implemented**); the feed-page and snapshot-start limits are **not built** (R-53); a device token cannot call export, calendar or password endpoints (T22) |
| T18 | Note content in logs/resolution log | Application logs carry ids, rule and field names only; the resolution table stores simple-field values only (never text or note content) - **implemented and tested by SYNC-05** |
| T20 | The resolution log as a way to read another user's data or to rewrite it (list, feed, undo by id) | every query filters on `user_id`; another user's id is `404 not_found` for read and undo (byte-identical to an unknown id); undo writes only through the entity's own user-scoped service |
| T21 | Undo used (or raced) to destroy newer data | strict write: any change of the field after the resolution is a `409 conflict`, never an overwrite; never revives a deleted entity; idempotent by key; one undo per resolution by a unique index |
| T22 | A device token used for account-level actions (change the password, export everything, connect calendars, revoke other devices) | default deny: `CurrentUser` is browser-only and answers a device `403 forbidden_scope`; `SyncUser` is applied to an explicit list; `test_the_set_of_endpoints_open_to_devices_is_exactly_this` walks every router and fails when the set changes; each closed endpoint is tested with a real device token |
| T23 | Confusion between the two credentials (a browser cookie riding a bearer request to skip CSRF, or a bad token rescued by a cookie) | a bearer header is authenticated alone and cookies are ignored; CSRF is skipped only for requests that carry one; a non-bearer `Authorization` header (reverse-proxy Basic auth) changes nothing; a session token is not a device token and vice versa; all tested in `test_device_security.py` |
| T24 | Token in logs, URLs, errors or backups | the token travels only in the `Authorization` header and the one `201`/rotation response; access logs carry path, status and duration; the `422` handler strips input on `/api/devices*`; errors never echo a token; the database holds hashes only (a stored hash presented as a token is refused); `test_no_token_reaches_the_logs_or_an_error` captures every log record of a full flow |
| T19 | Malicious Markdown in a synced folder | Unchanged (T3/T6): content is untrusted; the desktop renderer uses the same sanitised preview |

**Verified by SYNC-03 (server, 2026-11-03)** - T15: sync mode requires the idempotency key and base revision (`422`), refuses unknown
fields (`422 unknown_fields`) and answers `426` outside the supported range *before authentication*, so an old client stops
without a session; the field merge, edit-wins and every id rule run on the server (`tests/integration/test_sync_writes.py`,
`test_sync_protocol.py`). T16: `409 id_exists` for another user's id is byte-identical to the answer for an own taken id
(`test_another_users_id_is_indistinguishable_from_a_taken_one`); every new query is user-scoped (`load_entity_data` filters on
`user_id`). T18: `sync.resolution` carries overwritten simple-field values to the caller who made the write (a response to an
authenticated user about their own data); no value is logged, and the new code logs nothing about entities. The **epoch** is only
revealed to authenticated callers (the check runs after authentication; an unauthenticated caller with a wrong epoch gets `401`
and no epoch). New attack surface reviewed: `Atlas-Sync`/`Atlas-Epoch` headers are parsed with a strict ASCII-digit rule and a
length bound; `types=` is validated against a closed vocabulary (`422` otherwise); `include=data` reads are batched `IN` queries
bound to the user id. Limits unchanged: 200 items per data page; no per-device rate limit until SYNC-06.

**Verified by SYNC-04 (notes, 2026-11-03)** - new surface: the note history (a directory of copies of note text), the merge, the
conflict copy and the path rules.
- *Cross-user exposure:* a history row carries `user_id` and every read filters on it; a note id of another user is `404` for
  `GET .../history`, `GET .../history/{revision}`, `PUT`, merge and revive (`test_history_never_crosses_users`); a history file is
  addressed by the note's own id and the hash of its bytes, never by a client-supplied path (`history_*` validate the hash with a
  strict 64-hex rule, `UnsafePathError` otherwise; the directory is inside the notes root and `absolute()` still resolves
  symlinks and rejects escapes). A damaged or swapped file is never used (hash checked on read; tested).
- *Retention of deleted text (privacy):* deleting or overwriting a note no longer removes its text from the server at once: the
  last 20 revisions and 90 days of history stay in `.atlas/history`, in every backup, until pruned. This is the price of
  recoverable merges and edit-wins; it is documented to the operator (`OPERATOR_GUIDE.md`, `.env.example`), bounded
  (`NOTE_HISTORY_*`), and an operator who needs a note gone must also remove its history directory (R-44).
- *Untrusted content:* the merge treats note text as opaque lines (no parsing but a front-matter block comparison, no
  evaluation); size and time are bounded (5 MiB, 200 000 lines, 4 000 000 diff cells, then "not merged"). Lone surrogates and NUL
  are rejected at the schema (a lone surrogate used to turn the validation error itself into a `500`).
- *Paths:* sync mode refuses Windows-reserved names, forbidden characters, trailing dots/spaces, over-long names and case or
  normalisation collisions; `.atlas` stays rejected by the path validator; the server-chosen names (`name (2).md`, conflict copies)
  are derived from the validated path and shortened, never from other client input.
- *Logs:* the new code logs no note text or path (it logs nothing per write; the purge logs a count).

**Verified by SYNC-05 (resolution log, 2026-11-03)** - new surface: a table of overwritten values, three endpoints and a feed entity.
- *Cross-user:* `GET`/`POST .../undo` of another user's entry, an unknown id and the feed are tested to be indistinguishable or
  empty (`test_another_users_entries_are_invisible_and_cannot_be_undone`: list, get, undo, feed with and without `include=data`;
  the other user's row is untouched). Every query in `ResolutionLog` and `load_resolution_data` carries `user_id`; the cursor of the
  list is opaque and only narrows within the caller's rows.
- *No content stored or logged:* the table has no column that can hold text; `loser` is the overwritten value of a simple field only
  (bounded to 4 096 bytes); `detail` holds paths (bounded); tests assert that task text, descriptions and note content never appear
  in any row (`test_text_conflicts_are_not_resolutions...`, `test_a_merged_note_is_logged_without_content...`), that application
  logs of a full flow contain no value or path (`test_application_logs_carry_no_values`), and the simulation scans every entry of
  every run for the text its users type (`log_has_no_text`, with a planted defect). The new code logs only the count of purged rows.
  **Residual:** overwritten simple values (a status, a date, a path, a project id) and note paths remain in the database and its
  backups for the retention window (90 days) - the price of undo, like the note history (R-44); `CHANGE_RETENTION_DAYS` is the
  operator's control (minimum 30).
- *Abuse of undo:* see T21; the endpoint requires a key, a valid session (CSRF applies to cookie sessions as to every `POST`) and
  the epoch gate; payload sizes are bounded (no request body; responses carry at most one stored value of 4 096 bytes per entry; the
  list is capped at 200 entries per page).
- *SQL/XSS/path:* parameterised ORM queries only; the cursor is parsed strictly (`422` otherwise); stored paths are never used to
  touch the file system (an undo calls the ordinary rename, which validates its target as every move).

**Verified by SYNC-06 (device credentials, 2026-11-03)** - new surface: a second authentication path, a credential table and eight endpoints.
- *Token handling:* `secrets.token_urlsafe(32)` behind `atd_`; the shape is checked before any lookup (a 5 000-character header is a
  plain `401`); SHA-256 stored, never the token (`test_sign_in_returns_the_token_once_and_stores_only_its_hash`, a dump of the row
  contains neither the token nor the prefix, a stored hash used as a token is refused); `hmac.compare_digest` after the indexed lookup;
  shown once by sign-in and rotation only; absent from every log record, error body and header of a full flow.
- *The two paths:* see T23. The only CSRF-exempt additions are `POST /api/devices` (like login: it needs the password, creates no
  session and sets no cookie) and requests that present a bearer header.
- *Immediate revocation:* every request re-reads the device row (no cache), so a revoked device's next request is `401 token_revoked`;
  the grace token of a revoked device is cleared at the same time; `revoke_all_devices` is the single bulk path (Settings button, the
  password-change flag, `atlas-admin reset-password`, later AUTH-01).
- *Isolation:* every device query filters on `user_id`; another user's device id is `404` for rename and revoke, `revoke-all` touches only
  the caller's rows, a device token of user A reads nothing of user B (`test_devices_and_data_are_user_scoped`).
- *Enumeration and brute force:* sign-in shares the login limiter and answers all failures alike, with the dummy-hash timing
  equaliser; tokens cannot be guessed (256 bits) so the bearer path needs no lockout, only the per-device rate limit.
- *Clock:* no device clock is read; a forged `Date` header changes nothing.
- *Residual:* an attacker who knows the password can sign in as a new device (as they could log in): ticking "also sign out my devices"
  on a password change, or `atlas-admin reset-password`, ends every existing token, but the attacker's *new* device needs the new
  password; limiters are in-process (single API process, R-SEC-1); a stolen current token works until revoked (R-52); the OS keystore
  and HTTPS-only enforcement are client obligations (SYNC-09).

Open: keystore mechanism per platform (spike), HTTPS-only enforcement and the tailnet dev override, rate limiting behind a proxy
(R-SEC-1 keys on IP for sign-in; device limits key on device id).

## 13. Account recovery (AUTH-01, ADR-0067; implemented locally 2026-11-04)

A self-hosted Atlas has no e-mail service, so the owner keeps a one-time **recovery code** (150 random bits, shown once, stored as a
salted HMAC-SHA-256). With the account e-mail it resets the password without a session. The reset signs out every browser session and
every device in the transaction of the password change and replaces the code.

| # | Threat | Control |
|---|---|---|
| T25 | The code is leaked or stolen (a screenshot, a cloud-synced downloaded file, shoulder-surfing) | it is a full account takeover until replaced, so it is shown once, never stored in clear, never logged, and replaced by any use; the owner can regenerate it in Settings at any time (needs the password); a reset ends every session and device, so a thief's takeover is visible to the owner as a sign-out, and the owner's own use of the CLI/regeneration restores control. The owner is told to keep it like a password. Residual: nothing detects a leak before use (R-56) |
| T26 | Guessing the code | 150 random bits (2^-150 per guess); per-address limit (shared login pool, 10 a minute) and per-account limit (5 per 15 minutes) answered before the code is read; constant-time comparison; `failed_attempts` shown to the owner |
| T27 | User enumeration through the reset (unknown e-mail, no code, wrong code, inactive account) | one `400` body and one header set for all refusals; identical statements run in identical order whatever the account (SQL recorded and compared in `test_every_refusal_is_the_same_response_and_the_same_work`); no Argon2 on refusal; the account throttle keys on a hash of the e-mail and applies to unknown addresses identically; the e-mail is never logged |
| T28 | Using the limiter to lock the owner out | sliding window, not a lock: refused attempts are not counted, so the delay ends 15 minutes after the last counted attempt; sign-in is not affected; the CLI (`atlas-admin reset-password`, `recovery-code`) is the fallback. Residual: recovery (only) can be kept throttled by a persistent attacker spending 5 attempts per 15 minutes (R-57) |
| T29 | Replay or race of a used code | the code row is locked (`FOR UPDATE`) for the whole reset and replaced in the same transaction; two simultaneous resets succeed exactly once; a replay is the generic refusal; a failure anywhere (tested by failing the device revocation) leaves password, sessions and code unchanged |
| T30 | The code or password reaching logs, errors, backups, exports or other users | no request body is logged; the `422` handler strips `input` under `/api/auth/`; audit events carry ids and counts only; the database, the export and the `pg_dump` hold salt and hash only (scanned in tests); every query is keyed by the found account (cross-user tests both ways); a device gets `403 forbidden_scope` on the status and regenerate endpoints; `RECOVERY_ENABLED=false` removes the surface (reset and regenerate answer `404`) |

*Cookies and CSRF:* the reset is unauthenticated and, like login, setup and device sign-in, exempt from the CSRF check; it reads and
sets no cookie, so there is no ambient credential to ride. Regenerate is an ordinary authenticated write with CSRF and the current
password. *Authorisation after a reset:* the browser is not signed in; the owner signs in with the new password.
*Residual:* limiters are in-process (R-SEC-1); the code travels in a request body, so HTTPS is required exactly as for passwords (T9);
a restore from an older backup brings back the older code (`OPERATIONS.md` 2.2b).


## 14. Reminder notifications and the sync-hint channel (M8-04; DESIGN ONLY, ADR-0068 PROPOSED, 2026-11-04; none of the mitigations below exists yet)

Design: `SYNC_PROTOCOL.md` section 14. Rules carried from AGENTS.md 11 and 15: no telemetry, no user content to external services, nothing leaves the server toward a push provider except a constant, content-free message.

| ID | Threat | Mitigation (planned) and verification |
|---|---|---|
| T31 | Content leaks through the hint channel (task titles, counts, cursors, ids, times) to the gateway operator or a topic subscriber | Payload is the constant `{"v":1,"k":"sync"}`; a test compares the bytes sent for a task edit, a note edit and a reminder; no code path builds a hint from entity data; the interface takes no payload argument |
| T32 | SSRF: a device (or an attacker holding a device token) registers an endpoint that makes the server call an internal service or leak a secret | Gateway origin is operator config only; a registered endpoint must equal that origin (scheme, host, port) and match `^/up[A-Za-z0-9_-]{8,64}$`; https only (loopback http outside production); no redirects; no userinfo; 5 s timeout; response body capped at 1 KiB and never logged; the gateway credential is sent only to that origin. Table-driven tests with a fake gateway |
| T33 | Topic guessing, topic leakage, spurious wake-ups, subscription by a stranger | Distributor-generated random topic treated as a secret (masked in UI, absent from logs/exports/errors); rotation on request, on token rotation, after `invalid`, every 90 days; ntfy `deny-all` + anonymous write-only `up*` recommended (Q8); the client throttles hint-triggered syncs (15 s) and never trusts the body; consequence of a leak is limited to timing and wasted battery |
| T34 | Hint or long-poll used for denial of service or as an amplifier | Coalescing (one hint per user per 30 s), per-device rate limits (600/min, 120 writes/min), `/test` 1/min, at most 4 concurrent waits per user, 25 s cap, circuit breaker, bounded retries; no fan-out beyond the owner's devices |
| T35 | A revoked, expired or stolen device keeps receiving hints or polling | `device_hints` rows cascade-delete with the device; every wait poll re-authenticates (revoked token -> `401 token_revoked`); `last_seen_at` shows activity; a hint contains nothing to steal |
| T36 | Notification text exposes private content on a lock screen, in the plugin's stored schedule, or to a shoulder-surfer | Per-device `contentMode` chosen at scheduling time so `generic` never hands a title to the OS or the plugin's saved JSON (spy test); Android channel `visibility: Private`; desktop relies on the OS lock-screen setting; default `full`+`Private` is an owner question (Q5); the plugin's saved notification JSON sits in app-private storage with the Android app's sandbox (backups: `android:allowBackup="false"`, SYNC-07 S4) |
| T37 | Notification action or deep link abused (a crafted notification opens another task, completes the wrong task) | Actions carry only the `reminder_id`/task id from the local store; the app resolves them against the local store and the signed-in user; a completion is a normal authenticated task write; no URL or command is taken from a notification extra |
| T38 | The long-poll as an auth bypass or information source | Same `SyncUser` authentication as `/api/changes`; response is `{head, changed}` only; added deliberately to the exact-set-of-device-endpoints test; no data beyond a cursor number the client could read from `/api/changes` |

Residual risks: a stolen unlocked phone shows `full` content; a public ntfy instance leaks timing (documented, not recommended); the unverified payload-encryption requirement of UnifiedPush connectors (R-67). Exact-alarm permission and `POST_NOTIFICATIONS` widen the Android permission set, listed for the SYNC-10 security review.
