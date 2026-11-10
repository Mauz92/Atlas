"""OAuth 2.0 authorisation-code flow with PKCE for Google and Microsoft (M5-03/M5-04/M5-05).

Security properties (SECURITY.md T23, ADR-0071):

- **PKCE (S256)** on every flow, plus the client secret (both providers' web-app clients are
  confidential clients).
- **``state``** is 256 random bits, stored only as a SHA-256 hash, **single use** (``used_at``),
  **short-lived** (``CALENDAR_OAUTH_STATE_TTL_SECONDS``) and **bound to the browser session** that
  started the flow, so a callback replayed from another session, a stale callback or a forged
  ``state`` is refused before any provider call (login CSRF).
- The **redirect URI is derived** from ``PUBLIC_BASE_URL`` (``{base}/api/calendar/{provider}/
  callback``), validated (https, or http on loopback for local development) and stored with the
  state; the token exchange sends the stored value, never request input.
- **Minimal scopes**: Stage A is read-only (Google ``calendar.readonly``; Microsoft
  ``Calendars.Read`` + ``offline_access``). Write scopes belong to Stage B and are not requested.
  A grant that lacks the required scope is refused (Google lets a user untick it).
- Tokens go straight into the encrypted credential store; they are never logged, never put in a
  URL, never sent to the browser. Provider error bodies are not echoed.
"""

from __future__ import annotations

import base64
import hashlib
import secrets
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from urllib.parse import urlencode, urlsplit

import httpx
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.tokens import hash_session_token
from ..config import Settings, get_settings
from ..models import OAuthState, ProviderCredential
from .credentials import ProviderCredentialsService
from .crypto import DecryptionError, TokenCipher, get_token_cipher
from .errors import AuthExpiredError, PermanentProviderError, TransientProviderError
from .http import new_client
from .tokens import StoredCredential, TokenBundle

GOOGLE = "google"
MICROSOFT = "microsoft"
OAUTH_PROVIDERS = (GOOGLE, MICROSOFT)

GOOGLE_READONLY_SCOPE = "https://www.googleapis.com/auth/calendar.readonly"
MICROSOFT_READ_SCOPE = "Calendars.Read"

#: Refresh when the access token has less than this long left.
REFRESH_MARGIN = timedelta(seconds=90)
#: Stale ``oauth_states`` rows older than this are deleted whenever a flow starts.
STATE_RETENTION = timedelta(hours=24)


@dataclass(frozen=True, slots=True)
class ProviderEndpoints:
    auth_url: str
    token_url: str
    revoke_url: str | None
    api_origin: str
    api_base: str


def endpoints_for(provider: str, settings: Settings | None = None) -> ProviderEndpoints:
    """The provider's OAuth and API endpoints (the fake provider's when one is configured)."""
    cfg = settings or get_settings()
    fake = cfg.calendar_fake_provider_url.rstrip("/")
    if provider == GOOGLE:
        if fake:
            return ProviderEndpoints(
                f"{fake}/google/auth",
                f"{fake}/google/token",
                f"{fake}/google/revoke",
                fake,
                f"{fake}/google/calendar/v3",
            )
        return ProviderEndpoints(
            "https://accounts.google.com/o/oauth2/v2/auth",
            "https://oauth2.googleapis.com/token",
            "https://oauth2.googleapis.com/revoke",
            "https://www.googleapis.com",
            "https://www.googleapis.com/calendar/v3",
        )
    if provider == MICROSOFT:
        if fake:
            return ProviderEndpoints(
                f"{fake}/microsoft/authorize",
                f"{fake}/microsoft/token",
                None,
                fake,
                f"{fake}/microsoft/v1.0",
            )
        tenant = cfg.microsoft_tenant.strip() or "common"
        base = f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0"
        return ProviderEndpoints(
            f"{base}/authorize",
            f"{base}/token",
            None,  # the Microsoft identity platform has no token revocation endpoint (v2.0)
            "https://graph.microsoft.com",
            "https://graph.microsoft.com/v1.0",
        )
    raise ValueError(f"unknown OAuth provider {provider!r}")


def scopes_for(provider: str) -> tuple[str, ...]:
    if provider == GOOGLE:
        return (GOOGLE_READONLY_SCOPE,)
    return ("offline_access", MICROSOFT_READ_SCOPE)


def required_scope(provider: str) -> str:
    return GOOGLE_READONLY_SCOPE if provider == GOOGLE else MICROSOFT_READ_SCOPE


def redirect_uri_for(provider: str, settings: Settings | None = None) -> str:
    """``{PUBLIC_BASE_URL}/api/calendar/{provider}/callback`` - never hard-coded."""
    cfg = settings or get_settings()
    return f"{cfg.public_base_url.rstrip('/')}/api/calendar/{provider}/callback"


def _client_credentials(provider: str, cfg: Settings) -> tuple[str, str]:
    if provider == GOOGLE:
        return cfg.google_client_id.strip(), cfg.google_client_secret.strip()
    return cfg.microsoft_client_id.strip(), cfg.microsoft_client_secret.strip()


@dataclass(frozen=True, slots=True)
class ProviderSetup:
    """Whether a provider can be connected, and if not, what the operator must fix."""

    provider: str
    configured: bool
    redirect_uri: str
    #: Stable machine codes the UI maps to setup help (never secrets).
    problems: tuple[str, ...]


def provider_setup(provider: str, settings: Settings | None = None) -> ProviderSetup:
    cfg = settings or get_settings()
    client_id, client_secret = _client_credentials(provider, cfg)
    problems: list[str] = []
    if not client_id:
        problems.append("client_id_missing")
    if not client_secret:
        problems.append("client_secret_missing")
    uri = redirect_uri_for(provider, cfg)
    parts = urlsplit(uri)
    host = (parts.hostname or "").lower()
    loopback = host in {"localhost", "127.0.0.1", "::1"} or host.endswith(".localhost")
    if parts.scheme != "https" and not (parts.scheme == "http" and loopback):
        problems.append("public_base_url_not_https")
    if cfg.is_production and loopback:
        problems.append("public_base_url_is_local")
    return ProviderSetup(provider, not problems, uri, tuple(problems))


def startup_problems(settings: Settings | None = None) -> list[str]:
    """Human-readable configuration warnings for the startup log (no secrets)."""
    cfg = settings or get_settings()
    messages: list[str] = []
    for provider in OAUTH_PROVIDERS:
        client_id, client_secret = _client_credentials(provider, cfg)
        if bool(client_id) != bool(client_secret):
            messages.append(
                f"{provider.upper()}_CLIENT_ID and {provider.upper()}_CLIENT_SECRET must both"
                f" be set (or both empty): {provider} calendar connection stays disabled"
            )
        elif client_id and "public_base_url_not_https" in provider_setup(provider, cfg).problems:
            messages.append(
                f"PUBLIC_BASE_URL ({cfg.public_base_url}) is not https: {provider} will not accept"
                f" the redirect URI {redirect_uri_for(provider, cfg)}"
            )
    return messages


# --- PKCE / state ----------------------------------------------------------


def new_code_verifier() -> str:
    return secrets.token_urlsafe(48)  # 64 URL-safe characters (RFC 7636: 43-128)


def code_challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def hash_state(state: str) -> str:
    return hashlib.sha256(state.encode("utf-8")).hexdigest()


class OAuthError(Exception):
    """A flow failure with a safe, stable ``code`` the callback page can show."""

    def __init__(self, code: str, message: str | None = None) -> None:
        super().__init__(message or code)
        self.code = code


class NotConfiguredError(OAuthError):
    def __init__(self, problems: tuple[str, ...]) -> None:
        super().__init__("not_configured", "provider is not configured: " + ", ".join(problems))
        self.problems = problems


@dataclass(frozen=True, slots=True)
class TokenResponse:
    access_token: str
    refresh_token: str | None
    expires_at: datetime | None
    scopes: tuple[str, ...]
    token_type: str


def parse_token_response(data: object, *, now: datetime) -> TokenResponse:
    if not isinstance(data, dict):
        raise PermanentProviderError("the provider returned an unexpected token response")
    access = data.get("access_token")
    if not isinstance(access, str) or not access:
        raise PermanentProviderError("the provider returned no access token")
    refresh = data.get("refresh_token")
    expires_in = data.get("expires_in")
    expires_at = (
        now + timedelta(seconds=int(expires_in))
        if isinstance(expires_in, int | float) and not isinstance(expires_in, bool)
        else None
    )
    scope = data.get("scope")
    scopes = tuple(scope.split()) if isinstance(scope, str) else ()
    token_type = data.get("token_type")
    return TokenResponse(
        access_token=access,
        refresh_token=refresh if isinstance(refresh, str) and refresh else None,
        expires_at=expires_at,
        scopes=scopes,
        token_type=token_type if isinstance(token_type, str) and token_type else "Bearer",
    )


async def _post_token(
    provider: str, form: dict[str, str], *, now: datetime, timeout: float = 20.0
) -> TokenResponse:
    """POST the token endpoint; failures become content-free taxonomy errors."""
    cfg = get_settings()
    endpoints = endpoints_for(provider, cfg)
    client_id, client_secret = _client_credentials(provider, cfg)
    body = {**form, "client_id": client_id, "client_secret": client_secret}
    try:
        async with new_client(timeout=timeout) as client:
            response = await client.post(
                endpoints.token_url, data=body, headers={"Accept": "application/json"}
            )
    except httpx.HTTPError as exc:
        raise TransientProviderError("could not reach the provider", provider=provider) from exc
    if response.status_code >= 500 or response.status_code == 429:
        raise TransientProviderError(
            f"the provider answered HTTP {response.status_code}", provider=provider
        )
    try:
        data = response.json()
    except ValueError as exc:
        raise PermanentProviderError(
            "the provider returned an unreadable token response", provider=provider
        ) from exc
    if response.status_code >= 400:
        code = data.get("error") if isinstance(data, dict) else None
        short = code[:40] if isinstance(code, str) else "error"
        # ``invalid_grant`` = refresh/authorisation token revoked, expired or already used.
        if short in {"invalid_grant", "interaction_required", "consent_required"}:
            raise AuthExpiredError(
                f"the provider rejected the sign-in ({short})", provider=provider
            )
        raise PermanentProviderError(
            f"the provider refused the token request ({short})", provider=provider
        )
    return parse_token_response(data, now=now)


# --- the flow --------------------------------------------------------------


class OAuthFlowService:
    """Starts and completes one user's OAuth connection (strictly user-scoped)."""

    def __init__(
        self,
        session: AsyncSession,
        user_id: uuid.UUID,
        *,
        cipher: TokenCipher | None = None,
        now: datetime | None = None,
    ) -> None:
        self.session = session
        self.user_id = user_id
        self._cipher = cipher or get_token_cipher()
        self._fixed_now = now

    def _now(self) -> datetime:
        return self._fixed_now or datetime.now(UTC)

    @staticmethod
    def _aad(user_id: uuid.UUID, provider: str, state_hash: str) -> bytes:
        return f"oauth-verifier:{user_id}:{provider}:{state_hash}".encode()

    async def start(self, provider: str, *, session_token: str) -> str:
        """Create a pending state and return the provider's authorisation URL."""
        cfg = get_settings()
        setup = provider_setup(provider, cfg)
        if not setup.configured:
            raise NotConfiguredError(setup.problems)
        now = self._now()
        await self.session.execute(
            delete(OAuthState).where(OAuthState.expires_at < now - STATE_RETENTION)
        )
        state = secrets.token_urlsafe(32)
        state_hash = hash_state(state)
        verifier = new_code_verifier()
        self.session.add(
            OAuthState(
                user_id=self.user_id,
                provider=provider,
                state_hash=state_hash,
                session_hash=hash_session_token(session_token),
                verifier_ciphertext=self._cipher.encrypt(
                    verifier.encode("ascii"), aad=self._aad(self.user_id, provider, state_hash)
                ),
                key_id=self._cipher.active_key_id,
                redirect_uri=setup.redirect_uri,
                expires_at=now + timedelta(seconds=cfg.calendar_oauth_state_ttl_seconds),
            )
        )
        await self.session.flush()
        client_id, _ = _client_credentials(provider, cfg)
        params = {
            "response_type": "code",
            "client_id": client_id,
            "redirect_uri": setup.redirect_uri,
            "scope": " ".join(scopes_for(provider)),
            "state": state,
            "code_challenge": code_challenge(verifier),
            "code_challenge_method": "S256",
        }
        if provider == GOOGLE:
            # ``offline`` yields a refresh token; ``consent`` makes Google re-issue one on
            # reconnect.
            params.update({"access_type": "offline", "prompt": "consent"})
        else:
            params.update({"response_mode": "query", "prompt": "select_account"})
        return f"{endpoints_for(provider, cfg).auth_url}?{urlencode(params)}"

    async def consume(
        self, provider: str, state: str, session_token: str
    ) -> tuple[OAuthState, str]:
        """Validate and burn ``state``; return its row and the PKCE verifier.

        The single-use mark is a conditional ``UPDATE ... WHERE used_at IS NULL`` so two concurrent
        callbacks cannot both win.
        """
        state_hash = hash_state(state)
        row = await self.session.scalar(
            select(OAuthState).where(
                OAuthState.state_hash == state_hash,
                OAuthState.user_id == self.user_id,
                OAuthState.provider == provider,
            )
        )
        if row is None:
            raise OAuthError("invalid_state")
        if row.session_hash != hash_session_token(session_token):
            raise OAuthError("invalid_state")
        now = self._now()
        if row.expires_at <= now:
            raise OAuthError("state_expired")
        claimed = await self.session.execute(
            update(OAuthState)
            .where(OAuthState.id == row.id, OAuthState.used_at.is_(None))
            .values(used_at=now)
        )
        if int(getattr(claimed, "rowcount", 0) or 0) != 1:
            raise OAuthError("state_used")
        try:
            verifier = self._cipher.decrypt(
                row.verifier_ciphertext,
                key_id=row.key_id,
                aad=self._aad(self.user_id, provider, state_hash),
            ).decode("ascii")
        except DecryptionError as exc:
            raise OAuthError("invalid_state") from exc
        return row, verifier

    async def complete(
        self, provider: str, *, state: str, code: str, session_token: str
    ) -> StoredCredential:
        """Validate ``state``, exchange ``code`` and store the encrypted tokens."""
        row, verifier = await self.consume(provider, state, session_token)
        # Commit the burn first: a failed exchange must not leave the state reusable.
        await self.session.commit()
        now = self._now()
        try:
            tokens = await _post_token(
                provider,
                {
                    "grant_type": "authorization_code",
                    "code": code,
                    "redirect_uri": row.redirect_uri,
                    "code_verifier": verifier,
                },
                now=now,
            )
        except AuthExpiredError as exc:
            raise OAuthError("code_rejected") from exc
        except TransientProviderError as exc:
            raise OAuthError("provider_unreachable") from exc
        except PermanentProviderError as exc:
            raise OAuthError("token_exchange_failed") from exc
        if tokens.scopes and required_scope(provider) not in tokens.scopes:
            raise OAuthError("insufficient_scope")
        if tokens.refresh_token is None:
            # No refresh token = the connection would die within the hour. Say so rather than
            # store a credential that silently expires.
            raise OAuthError("no_refresh_token")
        service = ProviderCredentialsService(self.session, self.user_id, cipher=self._cipher)
        await service.upsert(
            provider,
            tokens=TokenBundle(
                access_token=tokens.access_token,
                refresh_token=tokens.refresh_token,
                token_type=tokens.token_type,
            ),
            scopes=tokens.scopes or scopes_for(provider),
            access_expires_at=tokens.expires_at,
        )
        await self.session.execute(
            update(ProviderCredential)
            .where(
                ProviderCredential.user_id == self.user_id,
                ProviderCredential.provider == provider,
            )
            .values(needs_reauth_at=None)
        )
        await self.session.commit()
        return await service.read(provider)


# --- token lifecycle (adapters) --------------------------------------------


class TokenManager:
    """Gives an adapter a valid access token, refreshing server-side when needed.

    Refreshed tokens are held in :attr:`refreshed` for the caller to persist through the credential
    store (adapters have no database access); :func:`persist_refreshed` does that. An
    ``invalid_grant`` surfaces as :class:`AuthExpiredError` (the account needs re-authorising).
    """

    def __init__(self, provider: str, credential: StoredCredential) -> None:
        self.provider = provider
        self._access = credential.tokens.access_token
        self._refresh = credential.tokens.refresh_token
        self._expires_at = credential.metadata.access_expires_at
        self.refreshed: TokenResponse | None = None

    def _fresh(self, now: datetime) -> bool:
        if not self._access:
            return False
        return self._expires_at is None or self._expires_at - REFRESH_MARGIN > now

    async def access_token(self, *, force_refresh: bool = False) -> str:
        now = datetime.now(UTC)
        if not force_refresh and self._fresh(now):
            assert self._access is not None
            return self._access
        if not self._refresh:
            raise AuthExpiredError("no refresh token is stored", provider=self.provider)
        scope = " ".join(scopes_for(self.provider)) if self.provider == MICROSOFT else ""
        form = {"grant_type": "refresh_token", "refresh_token": self._refresh}
        if scope:
            form["scope"] = scope
        response = await _post_token(self.provider, form, now=now)
        self._access = response.access_token
        self._expires_at = response.expires_at
        if response.refresh_token:  # Microsoft rotates it; Google usually does not
            self._refresh = response.refresh_token
        self.refreshed = TokenResponse(
            access_token=response.access_token,
            refresh_token=self._refresh,
            expires_at=response.expires_at,
            scopes=response.scopes,
            token_type=response.token_type,
        )
        return self._access


async def persist_refreshed(
    session: AsyncSession, user_id: uuid.UUID, provider: str, manager: TokenManager | None
) -> None:
    """Store tokens a :class:`TokenManager` refreshed (no-op when none) and commit."""
    if manager is None or manager.refreshed is None:
        return
    refreshed = manager.refreshed
    manager.refreshed = None
    await ProviderCredentialsService(session, user_id).refresh(
        provider,
        access_token=refreshed.access_token,
        refresh_token=refreshed.refresh_token,
        access_expires_at=refreshed.expires_at,
    )
    await session.commit()


async def mark_needs_reauth(session: AsyncSession, user_id: uuid.UUID, provider: str) -> None:
    """Record that the provider rejected the stored sign-in; syncs skip the account until
    reconnect."""
    await session.rollback()
    await session.execute(
        update(ProviderCredential)
        .where(
            ProviderCredential.user_id == user_id,
            ProviderCredential.provider == provider,
            ProviderCredential.needs_reauth_at.is_(None),
        )
        .values(needs_reauth_at=datetime.now(UTC))
    )
    await session.commit()


async def revoke_at_provider(provider: str, credential: StoredCredential) -> bool:
    """Best-effort token revocation. Returns ``True`` when the provider confirmed it.

    Google exposes a revocation endpoint (revoking the refresh token revokes the grant); Microsoft's
    v2.0 endpoint has none, so the user must remove the app at ``account.live.com/consent/Manage``
    (personal) or ``myapps.microsoft.com`` (work) - the UI and the setup guide say so. Failure never
    blocks a local disconnect.
    """
    endpoints = endpoints_for(provider)
    if endpoints.revoke_url is None:
        return False
    token = credential.tokens.refresh_token or credential.tokens.access_token
    if not token:
        return False
    try:
        async with new_client(timeout=10.0) as client:
            response = await client.post(endpoints.revoke_url, data={"token": token})
    except httpx.HTTPError:
        return False
    return response.status_code == 200
