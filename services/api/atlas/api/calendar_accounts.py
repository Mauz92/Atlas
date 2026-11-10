"""Calendar accounts, calendars, ICS feeds and the unified event view (Stage A, read-only).

M5-03/M5-04/M5-05/M5-07/M5-11, ADR-0071. Connecting, disconnecting and feed management are for the
signed-in **browser** session (a device token is refused by ``CurrentUser``). The three read-only
GETs (accounts, events, event detail) also accept a device token (``SyncUser``) so the desktop
calendar page can display events; they expose no secret (feed URLs are masked). Strictly
user-scoped, and read-only towards providers: nothing here writes to Google, Microsoft or a feed.

- ``GET  /api/calendar/accounts`` - the three provider cards (configured? connected? calendars).
- ``POST /api/calendar/accounts/{provider}/connect`` - start OAuth; returns the authorisation URL.
- ``GET  /api/calendar/{provider}/callback`` - the redirect target registered at the provider
  (built from ``PUBLIC_BASE_URL``); validates ``state``, exchanges the code, then redirects the
  browser
  to the Settings page with a result code. Tokens never reach the browser.
- ``DELETE /api/calendar/accounts/{provider}`` - disconnect (revoke where supported, delete the
  credential, calendars and projected events).
- ``PATCH /api/calendar/sources/{id}``, ``POST/DELETE /api/calendar/feeds`` - selection, colour,
  feeds.
- ``GET /api/calendar/events`` and ``/events/{id}`` - occurrences for a bounded window.
"""

from __future__ import annotations

import logging
import uuid
from datetime import date, datetime
from typing import Annotated, Literal, NoReturn

from fastapi import APIRouter, HTTPException, Query, Request, status
from fastapi.responses import RedirectResponse
from pydantic import AnyUrl, BaseModel, Field, field_validator
from sqlalchemy import select

from ..auth.ratelimit import RateLimiter
from ..calendar import SyncStatusService
from ..calendar.events import (
    DEFAULT_LIMIT,
    MAX_LIMIT,
    EventItem,
    EventQueryService,
    WindowError,
)
from ..calendar.feed import FeedError, FeedUnreachableError
from ..calendar.ics import ICS, preview_feed
from ..calendar.netguard import UnsafeUrlError, validate_target
from ..calendar.oauth import (
    GOOGLE,
    MICROSOFT,
    NotConfiguredError,
    OAuthError,
    OAuthFlowService,
    persist_refreshed,
    provider_setup,
    revoke_at_provider,
)
from ..calendar.registry import production_registry
from ..calendar.sources import CalendarSourceService, SourceError
from ..calendar.status import SyncState
from ..config import get_settings
from ..jobs.handlers import enqueue_calendar_sync
from ..models import CalendarSource, ProviderCredential
from .deps import CurrentUser, DbSession, SyncUser

logger = logging.getLogger("atlas.calendar")
router = APIRouter(prefix="/api/calendar", tags=["calendar"])

OAuthProvider = Literal["google", "microsoft"]
_PROVIDER_LABELS = {
    GOOGLE: "Google Calendar",
    MICROSOFT: "Microsoft Outlook",
    ICS: "Calendar feed (ICS)",
}
_feed_limiter = RateLimiter(limit=12)

# --- schemas ---------------------------------------------------------------


class SourceOut(BaseModel):
    """One displayable calendar. No provider id, no feed URL (only a masked display form)."""

    id: uuid.UUID
    provider: str
    name: str
    color: str | None
    time_zone: str
    is_read_only: bool
    is_primary: bool
    selected: bool
    feed_url_display: str | None = None
    state: SyncState | None = None
    last_success_at: datetime | None = None
    last_error: str | None = None
    last_error_at: datetime | None = None


class ProviderAccountOut(BaseModel):
    provider: str
    label: str
    #: ``False`` = the operator has not set the client id/secret (or ``PUBLIC_BASE_URL`` is
    #: unusable):
    #: the UI shows ``setup_problems`` help instead of a Connect button. Always ``True`` for ICS.
    configured: bool
    setup_problems: list[str]
    #: The exact redirect URI to register at the provider (built from ``PUBLIC_BASE_URL``).
    redirect_uri: str | None
    connected: bool
    needs_reauth: bool
    scopes: list[str]
    calendars: list[SourceOut]
    poll_seconds: int | None = None


class AccountsOut(BaseModel):
    providers: list[ProviderAccountOut]


class ConnectOut(BaseModel):
    authorization_url: str


class DisconnectOut(BaseModel):
    revoked_at_provider: bool
    calendars_removed: int
    events_removed: int


class SourceUpdateRequest(BaseModel):
    selected: bool | None = None
    color: Annotated[str, Field(pattern=r"^[1-8]$")] | None = None
    name: Annotated[str, Field(min_length=1, max_length=200)] | None = None


class FeedUrlRequest(BaseModel):
    url: Annotated[str, Field(min_length=8, max_length=2048)]

    @field_validator("url")
    @classmethod
    def _no_whitespace(cls, value: str) -> str:
        return value.strip()


class FeedCreateRequest(FeedUrlRequest):
    name: Annotated[str, Field(min_length=1, max_length=200)]
    color: Annotated[str, Field(pattern=r"^[1-8]$")] | None = None


class FeedPreviewOut(BaseModel):
    event_count: int
    name: str | None
    skipped: int


class EventOut(BaseModel):
    id: uuid.UUID
    occurrence: str | None
    source_id: uuid.UUID
    provider: str
    title: str | None
    start: datetime
    end: datetime
    time_zone: str
    is_all_day: bool
    start_date: date | None
    end_date: date | None
    status: str
    is_recurring: bool
    location: str | None


class EventDetailOut(EventOut):
    description: str | None
    web_link: AnyUrl | None
    calendar_name: str
    is_read_only: bool
    last_synced_at: datetime


class EventListOut(BaseModel):
    events: list[EventOut]
    total: int
    truncated: bool


# --- helpers ---------------------------------------------------------------


def _bad(code: str, message: str, http: int = status.HTTP_400_BAD_REQUEST) -> NoReturn:
    raise HTTPException(status_code=http, detail={"code": code, "message": message})


def _source_out(row: CalendarSource, sync: dict[str, object] | None = None) -> SourceOut:
    sync = sync or {}
    return SourceOut(
        id=row.id,
        provider=row.provider,
        name=row.name,
        color=row.color,
        time_zone=row.time_zone,
        is_read_only=row.is_read_only,
        is_primary=row.is_primary,
        selected=row.selected,
        feed_url_display=row.feed_url_display,
        state=sync.get("state"),
        last_success_at=sync.get("last_success_at"),
        last_error=sync.get("last_error"),
        last_error_at=sync.get("last_error_at"),
    )


def _event_out(item: EventItem) -> EventOut:
    return EventOut(
        id=item.id,
        occurrence=item.occurrence,
        source_id=item.source_id,
        provider=item.provider,
        title=item.title,
        start=item.start,
        end=item.end,
        time_zone=item.time_zone,
        is_all_day=item.is_all_day,
        start_date=item.start_date,
        end_date=item.end_date,
        status=item.status,
        is_recurring=item.is_recurring,
        location=item.location,
    )


def _session_token(request: Request) -> str:
    return request.cookies.get(get_settings().session_cookie_name, "")


# --- accounts --------------------------------------------------------------


@router.get("/accounts", response_model=AccountsOut)
async def list_accounts(user: SyncUser, session: DbSession) -> AccountsOut:
    """The Google, Microsoft and ICS cards: setup state, connection state and calendars."""
    settings = get_settings()
    statuses = {item.provider: item for item in await SyncStatusService(session, user.id).status()}
    rows = await CalendarSourceService(session, user.id).list_sources()
    credentials = {
        row.provider: row
        for row in await session.scalars(
            select(ProviderCredential).where(ProviderCredential.user_id == user.id)
        )
    }
    providers: list[ProviderAccountOut] = []
    for provider in (GOOGLE, MICROSOFT, ICS):
        status_item = statuses.get(provider)
        per_calendar = {c.calendar_id: c for c in (status_item.calendars if status_item else ())}
        calendars = []
        for row in rows:
            if row.provider != provider:
                continue
            cursor = per_calendar.get(row.external_id)
            calendars.append(
                _source_out(
                    row,
                    {
                        "state": cursor.state,
                        "last_success_at": cursor.last_success_at,
                        "last_error": cursor.last_error,
                        "last_error_at": cursor.last_error_at,
                    }
                    if cursor
                    else None,
                )
            )
        if provider == ICS:
            providers.append(
                ProviderAccountOut(
                    provider=ICS,
                    label=_PROVIDER_LABELS[ICS],
                    configured=True,
                    setup_problems=[],
                    redirect_uri=None,
                    connected=bool(calendars),
                    needs_reauth=False,
                    scopes=[],
                    calendars=calendars,
                    poll_seconds=settings.ics_poll_seconds,
                )
            )
            continue
        setup = provider_setup(provider, settings)
        credential = credentials.get(provider)
        providers.append(
            ProviderAccountOut(
                provider=provider,
                label=_PROVIDER_LABELS[provider],
                configured=setup.configured,
                setup_problems=list(setup.problems),
                redirect_uri=setup.redirect_uri,
                connected=credential is not None,
                needs_reauth=credential is not None and credential.needs_reauth_at is not None,
                scopes=list(credential.scopes) if credential else [],
                calendars=calendars,
            )
        )
    return AccountsOut(providers=providers)


@router.post("/accounts/{provider}/connect", response_model=ConnectOut)
async def connect_account(
    provider: OAuthProvider, request: Request, user: CurrentUser, session: DbSession
) -> ConnectOut:
    """Start the OAuth flow; the browser then navigates to ``authorization_url``.

    ``409 not_configured`` (with the missing settings) when the operator has not set the provider's
    client id/secret: the UI shows setup help instead of a broken redirect.
    """
    try:
        url = await OAuthFlowService(session, user.id).start(
            provider, session_token=_session_token(request)
        )
    except NotConfiguredError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "not_configured",
                "message": "this provider is not configured on the server",
                "problems": list(exc.problems),
            },
        ) from exc
    await session.commit()
    return ConnectOut(authorization_url=url)


def _landing(provider: str, result: str) -> RedirectResponse:
    return RedirectResponse(
        f"/settings/calendar?calendar_provider={provider}&calendar_result={result}",
        status_code=status.HTTP_303_SEE_OTHER,
    )


@router.get("/{provider}/callback", include_in_schema=False)
async def oauth_callback(
    provider: OAuthProvider,
    request: Request,
    user: CurrentUser,
    session: DbSession,
    code: Annotated[str | None, Query(max_length=2048)] = None,
    state: Annotated[str | None, Query(max_length=512)] = None,
    error: Annotated[str | None, Query(max_length=128)] = None,
) -> RedirectResponse:
    """The redirect URI registered with the provider. Always answers with a redirect to Settings.

    The ``code`` and ``state`` query values are never logged (the access log records the path only)
    and never echoed back; only a stable result code is placed in the landing URL.
    """
    flow = OAuthFlowService(session, user.id)
    if not state:
        return _landing(provider, "invalid_state")
    if error or not code:
        # The user cancelled or the provider refused: burn the state, report a safe code.
        try:
            await flow.consume(provider, state, _session_token(request))
            await session.commit()
        except OAuthError:
            await session.rollback()
        return _landing(provider, "access_denied" if error == "access_denied" else "denied")
    try:
        credential = await flow.complete(
            provider, state=state, code=code, session_token=_session_token(request)
        )
    except OAuthError as exc:
        await session.rollback()
        return _landing(provider, exc.code)

    result = "connected"
    try:
        adapter = production_registry().create(provider, credential)
        await CalendarSourceService(session, user.id).discover(provider, adapter)
        await session.commit()
        await persist_refreshed(session, user.id, provider, getattr(adapter, "tokens", None))
        await enqueue_calendar_sync(session, user.id)
        await session.commit()
    except Exception:  # the credential is stored; "Sync now" retries discovery
        await session.rollback()
        logger.warning("calendar discovery failed after connect", extra={"provider": provider})
        result = "discovery_failed"
    return _landing(provider, result)


@router.delete("/accounts/{provider}", response_model=DisconnectOut)
async def disconnect_account(
    provider: OAuthProvider, user: CurrentUser, session: DbSession
) -> DisconnectOut:
    """Disconnect: revoke at the provider where possible, then delete the credential, the account's
    calendars, sync cursors and projected events (a cache; reconnecting re-syncs)."""
    from ..calendar import CredentialNotFoundError, ProviderCredentialsService

    try:
        credential = await ProviderCredentialsService(session, user.id).read(provider)
    except CredentialNotFoundError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found") from exc
    revoked = await revoke_at_provider(provider, credential)
    removed = await CalendarSourceService(session, user.id).disconnect(provider)
    await session.commit()
    return DisconnectOut(
        revoked_at_provider=revoked,
        calendars_removed=removed["calendars"],
        events_removed=removed["events"],
    )


# --- sources and feeds -----------------------------------------------------


@router.patch("/sources/{source_id}", response_model=SourceOut)
async def update_source(
    source_id: uuid.UUID, payload: SourceUpdateRequest, user: CurrentUser, session: DbSession
) -> SourceOut:
    """Show/hide a calendar, change its colour (palette 1-8) or rename a feed."""
    try:
        row = await CalendarSourceService(session, user.id).update(
            source_id, selected=payload.selected, color=payload.color, name=payload.name
        )
        if payload.selected:
            await enqueue_calendar_sync(session, user.id)
    except SourceError as exc:
        if exc.code == "not_found":
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found") from exc
        _bad(exc.code, str(exc))
    await session.commit()
    return _source_out(row)


def _check_feed_rate(user_id: uuid.UUID) -> None:
    key = str(user_id)
    if not _feed_limiter.allow(key):
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "Too many feed requests",
            headers={"Retry-After": str(_feed_limiter.retry_after(key))},
        )


@router.post("/feeds/preview", response_model=FeedPreviewOut)
async def preview_feed_url(payload: FeedUrlRequest, user: CurrentUser) -> FeedPreviewOut:
    """Fetch a feed once and report how many events it holds. Nothing is stored; errors are safe
    (the URL is a secret and is never echoed)."""
    _check_feed_rate(user.id)
    try:
        count, name, skipped = await preview_feed(payload.url)
    except FeedUnreachableError as exc:
        _bad("unreachable", str(exc), status.HTTP_502_BAD_GATEWAY)
    except FeedError as exc:
        _bad(exc.code, str(exc))
    except UnsafeUrlError as exc:
        _bad(exc.code, str(exc))
    return FeedPreviewOut(event_count=count, name=name, skipped=skipped)


@router.post("/feeds", response_model=SourceOut, status_code=status.HTTP_201_CREATED)
async def add_feed(payload: FeedCreateRequest, user: CurrentUser, session: DbSession) -> SourceOut:
    """Add a secret ICS feed (Proton "Share via link" or any ICS URL). The URL is stored sealed."""
    _check_feed_rate(user.id)
    try:
        await validate_target(payload.url)  # refuse a blocked address now, not on first poll
    except UnsafeUrlError as exc:
        _bad(exc.code, str(exc))
    try:
        row = await CalendarSourceService(session, user.id).add_feed(
            url=payload.url, name=payload.name, color=payload.color
        )
    except SourceError as exc:
        _bad(exc.code, str(exc))
    await enqueue_calendar_sync(session, user.id)
    await session.commit()
    return _source_out(row)


@router.delete("/feeds/{source_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_feed(source_id: uuid.UUID, user: CurrentUser, session: DbSession) -> None:
    """Remove a feed and its projected events."""
    try:
        await CalendarSourceService(session, user.id).remove_feed(source_id)
    except SourceError as exc:
        if exc.code == "not_found":
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found") from exc
        _bad(exc.code, str(exc))
    await session.commit()


# --- events ----------------------------------------------------------------


@router.get("/events", response_model=EventListOut)
async def list_events(
    user: SyncUser,
    session: DbSession,
    start: datetime,
    end: datetime,
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT,
    offset: Annotated[int, Query(ge=0, le=100_000)] = 0,
) -> EventListOut:
    """Occurrences overlapping ``[start, end)`` (UTC instants, at most 100 days) for the caller's
    selected calendars, recurring series expanded for the window. Read-only."""
    try:
        window = await EventQueryService(session, user.id).window(
            start, end, limit=limit, offset=offset
        )
    except WindowError as exc:
        _bad("invalid_window", str(exc), 422)
    return EventListOut(
        events=[_event_out(item) for item in window.items],
        total=window.total,
        truncated=window.truncated,
    )


@router.get("/events/{event_id}", response_model=EventDetailOut)
async def event_detail(
    event_id: uuid.UUID,
    user: SyncUser,
    session: DbSession,
    occurrence: Annotated[str | None, Query(pattern=r"^\d{8}T\d{6}Z$")] = None,
) -> EventDetailOut:
    """One event or one occurrence of a series, with its description and provider link."""
    item = await EventQueryService(session, user.id).detail(event_id, occurrence)
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    source = await CalendarSourceService(session, user.id).get(item.source_id)
    link = item.web_link if item.web_link and item.web_link.lower().startswith("https://") else None
    base = _event_out(item).model_dump()
    return EventDetailOut(
        **base,
        description=item.description,
        web_link=link,
        calendar_name=source.name,
        is_read_only=source.is_read_only,
        last_synced_at=item.row.last_synced_at,
    )
