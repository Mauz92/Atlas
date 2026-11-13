"""Calendar sync status read model and the manual sync trigger (M5-08).

Stage A/B of the calendar integration (``CALENDAR_SYNC.md`` §3) must be **observable**
(``ARCHITECTURE.md`` §6.3 step 4: a terminal failure "surface[s] to sync status"; AGENTS.md §10:
"Observable sync state"). This module turns the durable state M5-06 already writes — the
``sync_cursors`` rows (``last_success_at``/``last_error``/``last_error_at`` + the cursor) plus the
presence of an encrypted credential — into a typed, strictly user-scoped status.

**One source of truth, no parallel store.** The status is *derived on read* from the existing
``sync_cursors`` and ``provider_credentials`` tables; it is never written. Everything here is a pure
function of those rows, so the status can never disagree with what the sync actually did
(``DECISIONS.md`` ADR-0030).

The state vocabulary is deliberately limited to what the durable rows can prove:

- ``never_synced`` — no successful pass has completed yet (no cursor row, or a row that only records
  an error);
- ``in_progress`` — a sync run is **currently underway** for that calendar (M5-10): the durable
  ``sync_started_at`` marker is set and fresh (see
  :func:`atlas.calendar.reconcile.marker_is_active`);
- ``idle`` — the most recent outcome was a success (M5-06 clears ``last_error`` on success);
- ``error`` — the most recent recorded outcome was a failure (``last_error`` set).

The ``in_progress`` marker arrives with the scheduled reconciliation (M5-10, ADR-0031). It lives on
the ``sync_cursors`` row itself — the same rows the status already derives from — so there is still
**no parallel source of truth**. It is bounded by a freshness window
(:attr:`~atlas.config.Settings.calendar_sync_stale_seconds`): a marker left behind by a crashed run
is ignored (the status falls back to the last conclusive outcome) so the read never claims a run
that cannot be proven to be in progress (AGENTS.md §2/§16).

Nothing here contacts a provider. The optional :class:`ProviderSyncService` trigger builds an
adapter through the M5-02 registry seam (a real provider is unavailable while M5-00 is ``BLOCKED`` —
AR-001); in tests it is the in-memory fake.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import get_settings
from ..models import CalendarSource, ProviderCredential, SyncCursor
from .adapter import AdapterRegistry, build_adapter, canonical_provider
from .credentials import ProviderCredentialsService
from .errors import AuthExpiredError
from .oauth import mark_needs_reauth, persist_refreshed
from .reconcile import last_terminal_at, marker_is_active
from .sources import CalendarSourceService
from .sync import CalendarSyncService, SyncResult


def _default_now() -> datetime:
    return datetime.now(UTC)


class SyncState(StrEnum):
    """The derived sync state of a provider or one of its calendars.

    Exactly the states the durable ``sync_cursors`` row can prove (see the module docstring).
    """

    NEVER_SYNCED = "never_synced"
    IN_PROGRESS = "in_progress"
    IDLE = "idle"
    ERROR = "error"


class CursorHealth(StrEnum):
    """The health of one calendar's stored cursor.

    ``ok`` — a successful pass established a durable cursor and no error is outstanding;
    ``missing`` — no successful baseline yet (no cursor row, or the provider issued no cursor);
    ``error`` — the most recent pass failed, so the cursor did not advance.
    """

    OK = "ok"
    MISSING = "missing"
    ERROR = "error"


@dataclass(frozen=True, slots=True)
class CalendarSyncStatus:
    """The derived sync status of exactly one ``(provider, calendar)`` cursor row."""

    calendar_id: str
    state: SyncState
    cursor_health: CursorHealth
    cursor_type: str
    has_cursor: bool
    last_success_at: datetime | None
    last_error: str | None
    last_error_at: datetime | None
    in_progress: bool = False


@dataclass(frozen=True, slots=True)
class ProviderSyncStatus:
    """One provider's status: whether it is connected and the rolled-up state of its calendars."""

    provider: str
    connected: bool
    state: SyncState
    last_success_at: datetime | None
    last_error: str | None
    last_error_at: datetime | None
    calendars: tuple[CalendarSyncStatus, ...]
    #: The provider rejected the stored sign-in; the account must be re-authorised (M5-03/04).
    needs_reauth: bool = False


@dataclass(frozen=True, slots=True)
class CalendarSyncOutcome:
    """The observable outcome of one calendar's pass, as returned by the manual trigger."""

    calendar_id: str
    pages: int
    events_seen: int
    deletions_seen: int
    created: int
    updated: int
    unchanged: int
    tombstoned: int
    cursor_advanced: bool


@dataclass(frozen=True, slots=True)
class ProviderSyncOutcome:
    """The outcome of a manual ``sync_provider`` call: one entry per calendar exposed."""

    provider: str
    calendars: tuple[CalendarSyncOutcome, ...]


# --- pure derivation --------------------------------------------------------


def classify_cursor(
    *,
    has_cursor: bool,
    last_success_at: datetime | None,
    last_error: str | None,
    in_progress: bool = False,
) -> tuple[SyncState, CursorHealth]:
    """Derive ``(state, health)`` for one cursor row from its durable columns.

    A recorded error is the most recent outcome, because M5-06 clears ``last_error`` on every
    success — so ``last_error is not None`` means the last pass failed. Without a success and
    without an error there is simply no baseline yet. ``in_progress`` (a fresh M5-10 running marker)
    takes precedence: a run is actively underway right now, whatever the previous outcome was.
    """
    if in_progress:
        return SyncState.IN_PROGRESS, CursorHealth.OK if has_cursor else CursorHealth.MISSING
    if last_error is not None:
        return SyncState.ERROR, CursorHealth.ERROR
    if last_success_at is None:
        return SyncState.NEVER_SYNCED, CursorHealth.MISSING
    return SyncState.IDLE, CursorHealth.OK if has_cursor else CursorHealth.MISSING


def _latest_error(
    calendars: Sequence[CalendarSyncStatus],
) -> tuple[str | None, datetime | None]:
    """The most recently recorded error across ``calendars`` (or ``(None, None)``)."""
    errored = [item for item in calendars if item.last_error is not None]
    if not errored:
        return None, None
    latest = max(errored, key=lambda item: (item.last_error_at is not None, item.last_error_at))
    return latest.last_error, latest.last_error_at


def rollup_provider(
    calendars: Sequence[CalendarSyncStatus],
) -> tuple[SyncState, datetime | None, str | None, datetime | None]:
    """Roll a provider's calendars up into one ``(state, last_success_at, last_error, …)``.

    Any failing calendar makes the provider ``error``; otherwise any calendar actively syncing makes
    it ``in_progress``; otherwise any calendared success makes it ``idle``; otherwise it has never
    synced. ``last_success_at`` is the most recent success across calendars. Like
    :func:`classify_cursor`, this is a pure function of the derived rows.
    """
    if any(item.state is SyncState.ERROR for item in calendars):
        state = SyncState.ERROR
    elif any(item.state is SyncState.IN_PROGRESS for item in calendars):
        state = SyncState.IN_PROGRESS
    elif any(item.state is SyncState.IDLE for item in calendars):
        state = SyncState.IDLE
    else:
        state = SyncState.NEVER_SYNCED

    successes = [item.last_success_at for item in calendars if item.last_success_at is not None]
    last_error, last_error_at = _latest_error(calendars)
    return state, (max(successes) if successes else None), last_error, last_error_at


def _calendar_status(row: SyncCursor, *, now: datetime, stale_seconds: int) -> CalendarSyncStatus:
    has_cursor = row.cursor_value is not None
    in_progress = marker_is_active(
        row.sync_started_at,
        last_terminal_at(row.last_success_at, row.last_error_at),
        now=now,
        stale_seconds=stale_seconds,
    )
    state, health = classify_cursor(
        has_cursor=has_cursor,
        last_success_at=row.last_success_at,
        last_error=row.last_error,
        in_progress=in_progress,
    )
    return CalendarSyncStatus(
        calendar_id=row.calendar_id,
        state=state,
        cursor_health=health,
        cursor_type=row.cursor_type,
        has_cursor=has_cursor,
        last_success_at=row.last_success_at,
        last_error=row.last_error,
        last_error_at=row.last_error_at,
        in_progress=in_progress,
    )


# --- read model -------------------------------------------------------------


class SyncStatusService:
    """Reads the caller's calendar sync status, derived from the M5-06 tables."""

    def __init__(
        self,
        session: AsyncSession,
        user_id: uuid.UUID,
        *,
        now: Callable[[], datetime] | None = None,
        stale_seconds: int | None = None,
    ) -> None:
        self.session = session
        self.user_id = user_id
        self._now = now or _default_now
        self._stale_seconds = (
            stale_seconds
            if stale_seconds is not None
            else get_settings().calendar_sync_stale_seconds
        )

    async def _connected_providers(self) -> set[str]:
        """The providers the caller has a stored credential for (metadata only, no decryption)."""
        rows = await self.session.scalars(
            select(ProviderCredential.provider).where(ProviderCredential.user_id == self.user_id)
        )
        providers = set(rows)
        has_feed = await self.session.scalar(
            select(CalendarSource.id)
            .where(CalendarSource.user_id == self.user_id, CalendarSource.provider == "ics")
            .limit(1)
        )
        if has_feed is not None:
            providers.add("ics")
        return providers

    async def _needs_reauth(self) -> set[str]:
        rows = await self.session.scalars(
            select(ProviderCredential.provider).where(
                ProviderCredential.user_id == self.user_id,
                ProviderCredential.needs_reauth_at.is_not(None),
            )
        )
        return set(rows)

    async def _cursor_rows(self) -> list[SyncCursor]:
        return list(
            await self.session.scalars(
                select(SyncCursor)
                .where(SyncCursor.user_id == self.user_id)
                .order_by(SyncCursor.provider, SyncCursor.calendar_id)
            )
        )

    async def status(self) -> list[ProviderSyncStatus]:
        """The caller's per-provider, per-calendar sync status (never another user's).

        A provider appears when it is connected (has a credential) or when any of its calendars has
        a cursor row, so a sync that ran before its credential was re-added is still reported. The
        result is ordered by provider for a stable surface.
        """
        now = self._now()
        connected = await self._connected_providers()
        reauth = await self._needs_reauth()
        by_provider: dict[str, list[CalendarSyncStatus]] = {}
        for row in await self._cursor_rows():
            by_provider.setdefault(row.provider, []).append(
                _calendar_status(row, now=now, stale_seconds=self._stale_seconds)
            )

        providers = sorted(connected | set(by_provider))
        statuses: list[ProviderSyncStatus] = []
        for provider in providers:
            calendars = tuple(by_provider.get(provider, ()))
            state, last_success_at, last_error, last_error_at = rollup_provider(calendars)
            statuses.append(
                ProviderSyncStatus(
                    provider=provider,
                    connected=provider in connected,
                    state=state,
                    last_success_at=last_success_at,
                    last_error=last_error,
                    last_error_at=last_error_at,
                    calendars=calendars,
                    needs_reauth=provider in reauth,
                )
            )
        return statuses


# --- manual trigger ---------------------------------------------------------


def _calendar_outcome(result: SyncResult) -> CalendarSyncOutcome:
    advanced = result.cursor_after is not None and result.cursor_after != result.cursor_before
    return CalendarSyncOutcome(
        calendar_id=result.calendar_id,
        pages=result.pages,
        events_seen=result.events_seen,
        deletions_seen=result.deletions_seen,
        created=result.created,
        updated=result.updated,
        unchanged=result.unchanged,
        tombstoned=result.tombstoned,
        cursor_advanced=advanced,
    )


class ProviderSyncService:
    """Runs one manual read-sync for a provider, over the M5-02 registry seam.

    The orchestration only: read the caller's credential through the M5-01 store, build the adapter
    through the registry (the fake in tests; a real adapter once M5-03/M5-04 land), then drain every
    calendar the account exposes through the M5-06 :class:`~atlas.calendar.sync.CalendarSyncService`
    — which owns the cursor-safety transaction. It is **naturally idempotent**: a repeated call
    re-applies the same changes on the unique keys and never duplicates a projection. No provider is
    contacted here; building an adapter for a provider with no registered factory raises
    :class:`~atlas.calendar.errors.UnknownProviderError`.
    """

    def __init__(
        self,
        session: AsyncSession,
        user_id: uuid.UUID,
        *,
        registry: AdapterRegistry | None = None,
        credentials: ProviderCredentialsService | None = None,
    ) -> None:
        self.session = session
        self.user_id = user_id
        self._registry = registry
        self._credentials = credentials or ProviderCredentialsService(session, user_id)

    async def sync_provider(self, provider: str) -> ProviderSyncOutcome:
        """Sync every selected calendar the connected ``provider`` exposes, returning the outcomes.

        For Google/Microsoft the account's calendar list is rediscovered first (new calendars
        appear, the user's selection and colours are kept). ``ics`` syncs every feed. Raises
        :class:`~atlas.calendar.errors.CredentialNotFoundError` when the provider is not connected
        and :class:`~atlas.calendar.errors.UnknownProviderError` when no adapter is built.
        """
        name = canonical_provider(provider)
        if name == "ics":
            return await self._sync_feeds()
        credential = await self._credentials.read(name)
        adapter = build_adapter(name, credential, registry=self._registry)
        sources = CalendarSourceService(self.session, self.user_id)
        outcomes: list[CalendarSyncOutcome] = []
        try:
            await sources.discover(name, adapter)
            await self.session.commit()
            for row in await sources.selected(name):
                result = await CalendarSyncService(self.session, self.user_id).sync_calendar(
                    adapter, row.external_id
                )
                outcomes.append(_calendar_outcome(result))
        except AuthExpiredError:
            await mark_needs_reauth(self.session, self.user_id, name)
            raise
        finally:
            await persist_refreshed(
                self.session, self.user_id, name, getattr(adapter, "tokens", None)
            )
        return ProviderSyncOutcome(provider=name, calendars=tuple(outcomes))

    async def _sync_feeds(self) -> ProviderSyncOutcome:
        sources = CalendarSourceService(self.session, self.user_id)
        outcomes: list[CalendarSyncOutcome] = []
        errors: list[Exception] = []
        # Ids only: every sync commits (or rolls back), which expires any ORM row held across it, so
        # each feed is re-read just before it is synced (a second feed used to fail on a stale row).
        source_ids = [row.id for row in await sources.selected("ics")]
        for source_id in source_ids:
            try:
                row = await sources.get(source_id)
                external_id = row.external_id
                result = await CalendarSyncService(self.session, self.user_id).sync_calendar(
                    sources.ics_adapter(row), external_id
                )
            except Exception as exc:  # one feed failing must not block the others
                errors.append(exc)
                continue
            outcomes.append(_calendar_outcome(result))
        if errors and not outcomes:
            raise errors[0]
        return ProviderSyncOutcome(provider="ics", calendars=tuple(outcomes))


__all__ = [
    "CalendarSyncOutcome",
    "CalendarSyncStatus",
    "CursorHealth",
    "ProviderSyncOutcome",
    "ProviderSyncService",
    "ProviderSyncStatus",
    "SyncState",
    "SyncStatusService",
    "classify_cursor",
    "rollup_provider",
]
