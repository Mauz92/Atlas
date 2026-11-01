"""Periodic reconciliation fallback for calendar sync (M5-10).

Provider change notifications (webhooks) are **hints**, never a complete change log
(AGENTS.md §10, ``CALENDAR_SYNC.md`` §3/§9): a notification can be lost, delayed or never delivered
at all. This module is the safety net — a durable, scheduled **scan** that enumerates every
connected calendar *due* for a sync and re-runs the M5-06 ``CalendarSyncService`` from the **stored
cursor**. Because a pass from the cursor picks up exactly the changes it has not yet applied, a
change whose notification vanished is recovered on the next scan, and re-running the scan is
idempotent (the projection upserts on its unique key).

Two properties are non-negotiable and preserved here:

- **The cursor is the source of truth, never the scan.** The scan only *triggers* a pass; the pass
  itself reads the cursor and advances it only after the changes commit (M5-06, ADR-0029). A scan is
  therefore safe to run at any time and is never trusted in place of the cursor.
- **Restart safety via the durable queue.** The scan runs as a durable job (M1-08, ADR-0005) that
  survives a worker restart; if a run is interrupted, its per-calendar work is either already
  committed (concluded by the cursor) or not (re-fetched next scan), so nothing is lost, and the
  idempotent projection means nothing is duplicated.

**The durable running marker.** So that the M5-08 status read can report an *in-progress* sync
truthfully, a run records a durable ``sync_started_at`` marker on the ``sync_cursors`` row (its
**own** committed transaction, before the pass) and clears it when the run ends. The marker lives
on the same row the status already derives from — no parallel source of truth
(ADR-0030/ADR-0031). It is bounded by a freshness window
(:data:`~atlas.config.Settings.calendar_sync_stale_seconds`): within the window the status may
report ``in_progress``; past it the marker is treated as stale, ignored by the status (so a
crashed run cannot lie) and causes the calendar to be re-scanned.

Only the pure selection/marker rules and the orchestration live here; the transactional cursor
safety belongs to :mod:`atlas.calendar.sync`. No provider is contacted by this module directly — the
adapter is built through the M5-02 registry seam (the fake in tests; the real adapters once
M5-00/AR-001 unblocks and M5-03/M5-04 land).
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import get_settings
from ..models import ProviderCredential, SyncCursor
from .adapter import AdapterRegistry, CalendarAdapter, build_adapter
from .credentials import ProviderCredentialsService
from .errors import CredentialError, UnknownProviderError
from .sync import MAX_ERROR_LENGTH, CalendarSyncService
from .types import CursorType

#: The unique cursor key (one row per ``(user, provider, calendar)``), reused for the marker upsert.
_CURSOR_UNIQUE_CONSTRAINT = "uq_sync_cursors_user_provider_calendar"


def _default_now() -> datetime:
    return datetime.now(UTC)


def _error_message(exc: BaseException) -> str:
    """A bounded, diagnostic failure message (identical rule to the M5-06 sync service)."""
    text = str(exc) or exc.__class__.__name__
    return text[:MAX_ERROR_LENGTH]


def _cursor_type_value(cursor_type: CursorType | str) -> str:
    return str(getattr(cursor_type, "value", cursor_type))


# --- pure marker rules ------------------------------------------------------


def last_terminal_at(
    last_success_at: datetime | None, last_error_at: datetime | None
) -> datetime | None:
    """The most recent conclusive outcome instant across success and error (or ``None``)."""
    candidates = [value for value in (last_success_at, last_error_at) if value is not None]
    return max(candidates) if candidates else None


def marker_is_active(
    sync_started_at: datetime | None,
    last_terminal_at: datetime | None,
    *,
    now: datetime,
    stale_seconds: int,
) -> bool:
    """Whether a durable ``sync_started_at`` marker represents a *live* run at ``now``.

    ``False`` when there is no marker, when the marker is older than ``stale_seconds`` (a run that
    crashed without clearing it — it must not be reported as in progress), or when a conclusive
    outcome was reached *at or after* the marker was set (the run finished and the marker is merely
    not yet cleared). Otherwise the run is genuinely underway.
    """
    if sync_started_at is None:
        return False
    if sync_started_at <= now - timedelta(seconds=stale_seconds):
        return False
    return not (last_terminal_at is not None and last_terminal_at >= sync_started_at)


@dataclass(frozen=True, slots=True)
class CalendarDueState:
    """The durable state of one calendar, used to decide whether a scan should sync it."""

    calendar_id: str
    sync_started_at: datetime | None = None
    last_success_at: datetime | None = None
    last_error: str | None = None
    last_error_at: datetime | None = None

    @property
    def terminal_at(self) -> datetime | None:
        """The most recent conclusive outcome instant (success or recorded error)."""
        return last_terminal_at(self.last_success_at, self.last_error_at)


def is_due(
    state: CalendarDueState,
    *,
    now: datetime,
    interval_seconds: int,
    stale_seconds: int,
) -> bool:
    """Whether ``state`` is due for a scan at ``now``.

    A calendar is due when it has never synced, when its last successful sync is at least
    ``interval_seconds`` old, when its last outcome was an error (retry the failure), or when it
    carries a **stale** running marker (recover a run that crashed). It is *not* due while a live
    run is genuinely underway (a fresh marker), so a slow pass is never double-run.
    """
    if marker_is_active(
        state.sync_started_at, state.terminal_at, now=now, stale_seconds=stale_seconds
    ):
        return False
    if state.sync_started_at is not None:
        return True  # stale marker: recover/clear it
    if state.last_error is not None:
        return True
    if state.last_success_at is None:
        return True
    return state.last_success_at <= now - timedelta(seconds=interval_seconds)


# --- durable running marker -------------------------------------------------


async def begin_sync_run(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    provider: str,
    calendar_id: str,
    cursor_type: CursorType | str,
    now: datetime | None = None,
) -> datetime:
    """Set (and commit) the durable running marker for one calendar; returns the instant used.

    The marker is committed **before** the pass runs so it is observable (and crash-durable) while
    the pass is in flight. It never touches ``cursor_value``/``last_success_at`` — recording that a
    run started cannot advance or rewind the cursor.
    """
    started_at = now or _default_now()
    statement = (
        pg_insert(SyncCursor)
        .values(
            id=uuid.uuid4(),
            user_id=user_id,
            provider=provider,
            calendar_id=calendar_id,
            cursor_type=_cursor_type_value(cursor_type),
            sync_started_at=started_at,
        )
        .on_conflict_do_update(
            constraint=_CURSOR_UNIQUE_CONSTRAINT,
            set_={"sync_started_at": started_at, "updated_at": func.now()},
        )
    )
    await session.execute(statement)
    await session.commit()
    return started_at


async def end_sync_run(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    provider: str,
    calendar_id: str,
) -> None:
    """Clear (and commit) the durable running marker for one calendar.

    Idempotent: clearing a marker that is already clear, or on a row that no longer exists, is a
    no-op. It never writes ``cursor_value``/``last_success_at``/``last_error``.
    """
    await session.execute(
        update(SyncCursor)
        .where(
            SyncCursor.user_id == user_id,
            SyncCursor.provider == provider,
            SyncCursor.calendar_id == calendar_id,
        )
        .values(sync_started_at=None, updated_at=func.now())
    )
    await session.commit()


# --- orchestration ----------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ReconciledCalendar:
    """The outcome of one calendar's reconciliation pass (counts only — never event content)."""

    provider: str
    calendar_id: str
    synced: bool
    created: int = 0
    updated: int = 0
    unchanged: int = 0
    tombstoned: int = 0
    error: str | None = None


@dataclass(frozen=True, slots=True)
class ReconciliationSummary:
    """The outcome of one scan across every connected account."""

    accounts: int
    considered: int
    synced: int
    failed: int
    skipped: int
    unavailable: int
    calendars: tuple[ReconciledCalendar, ...]

    @property
    def changed(self) -> int:
        """How many calendars actually applied a change (created/updated/tombstoned something)."""
        return sum(
            1
            for item in self.calendars
            if item.synced and (item.created or item.updated or item.tombstoned)
        )


class CalendarReconciliationService:
    """Enumerates connected calendars and re-syncs the ones due, from their stored cursors.

    This is the durable periodic fallback (M5-10). It builds each account's adapter through the
    M5-02 registry seam, lists the calendars the account exposes, selects the ones *due* (see
    :func:`is_due`) and runs the M5-06 :class:`~atlas.calendar.sync.CalendarSyncService` for each —
    which owns the cursor-safety transaction. It is strictly user-scoped (every cursor query filters
    on the owning ``user_id``) and idempotent: a repeated scan re-applies the same changes on the
    projection's unique keys and never duplicates an event.
    """

    def __init__(
        self,
        session: AsyncSession,
        *,
        registry: AdapterRegistry | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self.session = session
        self._registry = registry
        self._now = now or _default_now

    async def scan(
        self,
        *,
        only_due: bool = True,
        interval_seconds: int | None = None,
        stale_seconds: int | None = None,
    ) -> ReconciliationSummary:
        """Scan every connected account once and re-sync each due calendar.

        ``only_due`` is exposed mainly for tests/diagnostics; a scan always uses the stored cursor
        and is idempotent either way. A provider with no registered adapter (M5-03/M5-04 pending) or
        an unreadable credential is skipped and counted ``unavailable`` rather than aborting the
        scan, and a single calendar's failure is recorded and retried next scan.
        """
        settings = get_settings()
        interval = (
            interval_seconds
            if interval_seconds is not None
            else settings.calendar_reconcile_seconds
        )
        stale = stale_seconds if stale_seconds is not None else settings.calendar_sync_stale_seconds

        accounts = await self._accounts()
        results: list[ReconciledCalendar] = []
        considered = synced = failed = skipped = unavailable = 0

        for user_id, provider in accounts:
            adapter = await self._build_adapter(user_id, provider)
            if adapter is None:
                unavailable += 1
                continue
            calendars = await adapter.list_calendars()
            cursor_rows = await self._cursor_rows(user_id, provider)
            now = self._now()
            for calendar in calendars:
                considered += 1
                state = _due_state(calendar.id, cursor_rows.get(calendar.id))
                if only_due and not is_due(
                    state, now=now, interval_seconds=interval, stale_seconds=stale
                ):
                    skipped += 1
                    continue
                outcome = await self._sync_calendar(user_id, provider, adapter, calendar.id)
                results.append(outcome)
                if outcome.synced:
                    synced += 1
                else:
                    failed += 1

        return ReconciliationSummary(
            accounts=len(accounts),
            considered=considered,
            synced=synced,
            failed=failed,
            skipped=skipped,
            unavailable=unavailable,
            calendars=tuple(results),
        )

    # --- internals ----------------------------------------------------------

    async def _accounts(self) -> list[tuple[uuid.UUID, str]]:
        """Every ``(user_id, provider)`` with a stored credential (the scan's starting set)."""
        rows = await self.session.execute(
            select(ProviderCredential.user_id, ProviderCredential.provider).order_by(
                ProviderCredential.user_id, ProviderCredential.provider
            )
        )
        return [(row[0], row[1]) for row in rows.all()]

    async def _build_adapter(self, user_id: uuid.UUID, provider: str) -> CalendarAdapter | None:
        """Build the account's adapter via the registry seam, or ``None`` when it is unavailable.

        An unreadable credential or a provider with no registered adapter is a skip, not a crash —
        while M5-00 is blocked the real adapters (M5-03/M5-04) simply do not exist, and a scan must
        still be a harmless no-op.
        """
        try:
            credential = await ProviderCredentialsService(self.session, user_id).read(provider)
        except CredentialError:
            return None
        try:
            return build_adapter(provider, credential, registry=self._registry)
        except UnknownProviderError:
            return None

    async def _cursor_rows(self, user_id: uuid.UUID, provider: str) -> dict[str, SyncCursor]:
        rows = await self.session.scalars(
            select(SyncCursor).where(SyncCursor.user_id == user_id, SyncCursor.provider == provider)
        )
        return {row.calendar_id: row for row in rows}

    async def _sync_calendar(
        self, user_id: uuid.UUID, provider: str, adapter: CalendarAdapter, calendar_id: str
    ) -> ReconciledCalendar:
        """Run one calendar's pass with the durable running marker set and reliably cleared.

        The marker is committed before the pass (so the status read can see it) and cleared in a
        ``finally`` whatever happens. A failed pass records its error on the cursor row (M5-06) and
        is retried next scan; it never advances the cursor.
        """
        await begin_sync_run(
            self.session,
            user_id=user_id,
            provider=provider,
            calendar_id=calendar_id,
            cursor_type=adapter.cursor_type,
            now=self._now(),
        )
        try:
            result = await CalendarSyncService(self.session, user_id, now=self._now).sync_calendar(
                adapter, calendar_id
            )
        except Exception as exc:  # a single calendar must not abort the whole scan
            return ReconciledCalendar(
                provider=provider,
                calendar_id=calendar_id,
                synced=False,
                error=_error_message(exc),
            )
        finally:
            await end_sync_run(
                self.session, user_id=user_id, provider=provider, calendar_id=calendar_id
            )
        return ReconciledCalendar(
            provider=provider,
            calendar_id=calendar_id,
            synced=True,
            created=result.created,
            updated=result.updated,
            unchanged=result.unchanged,
            tombstoned=result.tombstoned,
        )


def _due_state(calendar_id: str, row: SyncCursor | None) -> CalendarDueState:
    """Project a stored cursor row (or its absence) onto the pure :class:`CalendarDueState`."""
    if row is None:
        return CalendarDueState(calendar_id=calendar_id)
    return CalendarDueState(
        calendar_id=calendar_id,
        sync_started_at=row.sync_started_at,
        last_success_at=row.last_success_at,
        last_error=row.last_error,
        last_error_at=row.last_error_at,
    )


__all__ = [
    "CalendarDueState",
    "CalendarReconciliationService",
    "ReconciledCalendar",
    "ReconciliationSummary",
    "begin_sync_run",
    "end_sync_run",
    "is_due",
    "last_terminal_at",
    "marker_is_active",
]
