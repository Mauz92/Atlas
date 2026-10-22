# Atlas — Security

**Status:** Draft for approval (Milestone 0)
**Last updated:** 2026-10-20

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
- **R-SEC-3 — Symmetric key management.** `TOKEN_ENCRYPTION_KEY` is present but unused until
  OAuth lands in M5; key custody and rotation must be defined before then (M5).
- **R-SEC-4 — Single-user model.** Roles/permissions are not modelled; authorisation is
  "authenticated or not". Sufficient for the target deployment; revisit if multi-user is
  approved.

**Conclusion.** All M1-applicable controls are implemented and verified by test or live check.
Deferred items (T2, T3, T4, T10, T12) belong to later milestones and are recorded here so they
are not mistaken for verified controls.
