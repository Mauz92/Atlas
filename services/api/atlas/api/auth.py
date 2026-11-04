"""Authentication endpoints: first-run setup, login, logout, session info."""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime, timedelta
from functools import lru_cache

from fastapi import APIRouter, HTTPException, Request, Response, status
from sqlalchemy import func, select, update

from ..auth import (
    generate_session_token,
    hash_password,
    hash_session_token,
    issue_csrf_token,
    verify_password,
)
from ..auth.devices import revoke_all_devices
from ..auth.ratelimit import RateLimiter
from ..auth.recovery import (
    ACCOUNT_ATTEMPTS,
    ACCOUNT_WINDOW_SECONDS,
    RecoveryRefused,
    account_key,
    audit_event,
    issue_recovery_code,
    recovery_status,
    reset_password_with_code,
)
from ..config import get_settings
from ..models import AuthSession, User
from .deps import CurrentUser, DbSession, SyncUser
from .schemas import (
    LoginRequest,
    PasswordChange,
    ProfileUpdate,
    RecoveryCodeIssued,
    RecoveryRegenerate,
    RecoveryReset,
    RecoveryStatus,
    SetupRequest,
    SetupResult,
    SetupStatus,
    UserPublic,
)

router = APIRouter(tags=["auth"])

_login_limiter = RateLimiter(limit=get_settings().auth_rate_limit_per_minute)
# Password changes are another way to guess the current password, so they share the login budget
# (same limit and window) but are keyed per account rather than per address.
_password_limiter = RateLimiter(limit=get_settings().auth_rate_limit_per_minute)


# Forgot-password attempts are limited per address (the shared ``_login_limiter``) and per account
# (this one, keyed by a hash of the e-mail so an unknown address is throttled identically). A
# sliding window: the delay is bounded and ends by itself, never a permanent lock (ADR-0067).
_recovery_account_limiter = RateLimiter(limit=ACCOUNT_ATTEMPTS, per_seconds=ACCOUNT_WINDOW_SECONDS)


@lru_cache(maxsize=1)
def _dummy_password_hash() -> str:
    """A throwaway hash used to equalise login timing for unknown accounts."""
    return hash_password("atlas-timing-equalisation-dummy")


def _client_key(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _ip_hash(request: Request) -> str:
    host = _client_key(request)
    return hashlib.sha256(host.encode("utf-8")).hexdigest()


async def _users_exist(session: DbSession) -> bool:
    count = await session.scalar(select(func.count()).select_from(User))
    return bool(count)


def _set_session_cookies(response: Response, token: str) -> None:
    settings = get_settings()
    max_age = settings.session_ttl_seconds
    secure = settings.secure_cookies
    response.set_cookie(
        settings.session_cookie_name,
        token,
        max_age=max_age,
        path="/",
        samesite="lax",
        secure=secure,
        httponly=True,
    )
    response.set_cookie(
        settings.csrf_cookie_name,
        issue_csrf_token(token),
        max_age=max_age,
        path="/",
        samesite="lax",
        secure=secure,
        httponly=False,
    )


def _clear_session_cookies(response: Response) -> None:
    settings = get_settings()
    response.delete_cookie(settings.session_cookie_name, path="/")
    response.delete_cookie(settings.csrf_cookie_name, path="/")


async def _issue_session(
    session: DbSession, user: User, request: Request, response: Response
) -> None:
    settings = get_settings()
    token = generate_session_token()
    session.add(
        AuthSession(
            user_id=user.id,
            token_hash=hash_session_token(token),
            user_agent=(request.headers.get("user-agent") or "")[:400] or None,
            ip_hash=_ip_hash(request),
            expires_at=datetime.now(UTC) + timedelta(seconds=settings.session_ttl_seconds),
        )
    )
    await session.flush()
    _set_session_cookies(response, token)


@router.get("/api/setup/status", response_model=SetupStatus)
async def setup_status(session: DbSession) -> SetupStatus:
    return SetupStatus(
        setup_required=not await _users_exist(session),
        recovery_enabled=get_settings().recovery_enabled,
    )


@router.post("/api/auth/setup", response_model=SetupResult, status_code=status.HTTP_201_CREATED)
async def setup(
    payload: SetupRequest, request: Request, response: Response, session: DbSession
) -> SetupResult:
    if not _login_limiter.allow(_client_key(request)):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Too many requests"
        )
    if await _users_exist(session):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Application already initialised"
        )
    user = User(
        email=payload.email.lower(),
        display_name=payload.display_name,
        password_hash=hash_password(payload.password),
    )
    session.add(user)
    await session.flush()
    issued = None
    if get_settings().recovery_enabled:
        issued = await issue_recovery_code(session, user.id)
    await _issue_session(session, user, request, response)
    await session.commit()
    if issued is not None:
        audit_event("recovery_code_issued", user_id=str(user.id), ip_hash=_ip_hash(request))
    return SetupResult(
        id=user.id,
        email=user.email,
        display_name=user.display_name,
        recovery_code=issued.code if issued is not None else None,
    )


@router.post("/api/auth/login", response_model=UserPublic)
async def login(
    payload: LoginRequest, request: Request, response: Response, session: DbSession
) -> UserPublic:
    if not _login_limiter.allow(_client_key(request)):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Too many requests"
        )
    user = (
        await session.execute(select(User).where(User.email == payload.email.lower()))
    ).scalar_one_or_none()
    if user is None:
        # Verify against a dummy hash so a missing account is not distinguishable by timing.
        verify_password(_dummy_password_hash(), payload.password)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")
    if not user.is_active or not verify_password(user.password_hash, payload.password):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")
    await _issue_session(session, user, request, response)
    await session.commit()
    return UserPublic(id=user.id, email=user.email, display_name=user.display_name)


@router.post("/api/auth/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(request: Request, response: Response, session: DbSession) -> Response:
    settings = get_settings()
    token = request.cookies.get(settings.session_cookie_name)
    if token:
        auth_session = (
            await session.execute(
                select(AuthSession).where(AuthSession.token_hash == hash_session_token(token))
            )
        ).scalar_one_or_none()
        if auth_session is not None:
            auth_session.revoked_at = datetime.now(UTC)
            await session.commit()
    _clear_session_cookies(response)
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


@router.get("/api/auth/me", response_model=UserPublic)
async def me(user: SyncUser) -> UserPublic:
    return UserPublic(id=user.id, email=user.email, display_name=user.display_name)


@router.patch("/api/auth/me", response_model=UserPublic)
async def update_me(payload: ProfileUpdate, user: CurrentUser, session: DbSession) -> UserPublic:
    """Edit the display name (the only editable profile field; the email is the login identity)."""
    user.display_name = payload.display_name
    await session.commit()
    return UserPublic(id=user.id, email=user.email, display_name=user.display_name)


@router.post("/api/auth/password", status_code=status.HTTP_204_NO_CONTENT)
async def change_password(
    payload: PasswordChange,
    request: Request,
    response: Response,
    user: CurrentUser,
    session: DbSession,
) -> Response:
    """Change the caller's password (ADR-0050).

    The current password is required and rate limited like login. On success **every** session of
    the account is revoked (a stolen session must not survive a password change) and a fresh one is
    issued to the caller, so this browser stays signed in while other browsers must sign in again.
    Sync **devices** (desktop and mobile apps) keep their tokens unless ``revoke_devices`` is set
    (ADR-0059 D8, ADR-0065): a routine change must not break a working client, while someone who
    fears the old password was exposed ticks the box. A stolen individual device is revoked in
    Settings; a password *reset* always revokes every device. Neither password is ever logged or
    echoed (see the validation handler in ``main.py``).
    """
    if not _password_limiter.allow(str(user.id)):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Too many requests"
        )
    if not verify_password(user.password_hash, payload.current_password):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Current password is incorrect"
        )
    if payload.new_password == payload.current_password:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="New password must differ from the current password",
        )
    user.password_hash = hash_password(payload.new_password)
    await session.execute(
        update(AuthSession)
        .where(AuthSession.user_id == user.id, AuthSession.revoked_at.is_(None))
        .values(revoked_at=datetime.now(UTC))
    )
    if payload.revoke_devices:
        await revoke_all_devices(session, user.id)
    await _issue_session(session, user, request, response)
    await session.commit()
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


def _require_recovery_enabled() -> None:
    if not get_settings().recovery_enabled:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")


@router.get("/api/auth/recovery", response_model=RecoveryStatus)
async def recovery_code_status(user: CurrentUser, session: DbSession) -> RecoveryStatus:
    """Whether the account has a recovery code, and when it was made and last used (ADR-0067).

    Never the code or its hash. Browser sessions only (``CurrentUser``): a device cannot read it.
    """
    enabled = get_settings().recovery_enabled
    row = await recovery_status(session, user.id) if enabled else None
    return RecoveryStatus(
        enabled=enabled,
        configured=row is not None,
        created_at=row.created_at if row else None,
        last_used_at=row.last_used_at if row else None,
        failed_attempts=row.failed_attempts if row else 0,
    )


@router.post("/api/auth/recovery/regenerate", response_model=RecoveryCodeIssued)
async def regenerate_recovery_code(
    payload: RecoveryRegenerate, request: Request, user: CurrentUser, session: DbSession
) -> RecoveryCodeIssued:
    """Issue a new recovery code (the first one, or a replacement that kills the old one).

    Requires the current password (a stolen session alone must not be able to mint a way to take
    the account over), rate limited per account like a password change. Sessions and devices stay
    as they are. The response is the only time the new code is visible.
    """
    _require_recovery_enabled()
    if not _password_limiter.allow(str(user.id)):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many requests",
            headers={"Retry-After": str(_password_limiter.retry_after(str(user.id)))},
        )
    if not verify_password(user.password_hash, payload.current_password):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Current password is incorrect"
        )
    issued = await issue_recovery_code(session, user.id)
    await session.commit()
    audit_event("recovery_code_regenerated", user_id=str(user.id), ip_hash=_ip_hash(request))
    return RecoveryCodeIssued(recovery_code=issued.code, created_at=issued.created_at)


_RECOVERY_REFUSED = "The email or recovery code is not correct"


@router.post("/api/auth/recovery/reset", response_model=RecoveryCodeIssued)
async def reset_password_with_recovery_code(
    payload: RecoveryReset, request: Request, session: DbSession
) -> RecoveryCodeIssued:
    """Forgot password: set a new one with the recovery code (ADR-0067).

    Unauthenticated, so it is CSRF-exempt like login and neither reads nor sets a cookie. On
    success the password changes, **every** browser session and **every** device is signed out and
    the code is replaced, all in one transaction; the response carries the new code (shown once).
    This browser is *not* signed in: the owner signs in with the new password. Every refusal
    (unknown e-mail, account without a code, wrong or already used code) is the same ``400``.
    Limited per address and per account; a limited caller gets ``429`` and a ``Retry-After``,
    before any code is looked at.
    """
    _require_recovery_enabled()
    ip_key = _client_key(request)
    if not _login_limiter.allow(ip_key):
        audit_event("recovery_reset_throttled", scope="address", ip_hash=_ip_hash(request))
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many requests",
            headers={"Retry-After": str(_login_limiter.retry_after(ip_key))},
        )
    account = account_key(payload.email)
    if not _recovery_account_limiter.allow(account):
        audit_event("recovery_reset_throttled", scope="account", ip_hash=_ip_hash(request))
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many requests",
            headers={"Retry-After": str(_recovery_account_limiter.retry_after(account))},
        )
    try:
        outcome = await reset_password_with_code(
            session,
            payload.email,
            payload.recovery_code,
            payload.new_password,
            ip_hash=_ip_hash(request),
        )
    except RecoveryRefused:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=_RECOVERY_REFUSED
        ) from None
    return RecoveryCodeIssued(recovery_code=outcome.code, created_at=outcome.created_at)
