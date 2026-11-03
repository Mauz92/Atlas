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
from ..config import get_settings
from ..models import AuthSession, User
from .deps import CurrentUser, DbSession, SyncUser
from .schemas import (
    LoginRequest,
    PasswordChange,
    ProfileUpdate,
    SetupRequest,
    SetupStatus,
    UserPublic,
)

router = APIRouter(tags=["auth"])

_login_limiter = RateLimiter(limit=get_settings().auth_rate_limit_per_minute)
# Password changes are another way to guess the current password, so they share the login budget
# (same limit and window) but are keyed per account rather than per address.
_password_limiter = RateLimiter(limit=get_settings().auth_rate_limit_per_minute)


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
    return SetupStatus(setup_required=not await _users_exist(session))


@router.post("/api/auth/setup", response_model=UserPublic, status_code=status.HTTP_201_CREATED)
async def setup(
    payload: SetupRequest, request: Request, response: Response, session: DbSession
) -> UserPublic:
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
    await _issue_session(session, user, request, response)
    await session.commit()
    return UserPublic(id=user.id, email=user.email, display_name=user.display_name)


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
