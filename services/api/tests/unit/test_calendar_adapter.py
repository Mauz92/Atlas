"""Provider-neutral calendar adapter contract, neutral model and fake (M5-02).

No database and no network: these exercise the contract in :mod:`atlas.calendar.adapter`, the
neutral types in :mod:`atlas.calendar.types` and the in-memory fake in :mod:`atlas.calendar.fake`.
"""

from __future__ import annotations

import ast
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from atlas.calendar import (
    AdapterError,
    AdapterRegistry,
    Calendar,
    CalendarAdapter,
    CredentialMetadata,
    CredentialProvider,
    CursorType,
    Event,
    EventDeletion,
    EventPage,
    EventStatus,
    FakeCalendarAdapter,
    StoredCredential,
    TokenBundle,
    UnknownProviderError,
    build_adapter,
    canonical_provider,
    default_registry,
    fake_adapter_factory,
)

CALENDAR_ID = "cal-primary"
UPDATED = datetime(2026, 10, 26, 12, 0, tzinfo=UTC)


def _event(
    event_id: str,
    *,
    start_hour: int = 9,
    calendar_id: str = CALENDAR_ID,
    **overrides: object,
) -> Event:
    start = datetime(2026, 10, 27, start_hour, 0, tzinfo=UTC)
    fields: dict[str, object] = {
        "id": event_id,
        "calendar_id": calendar_id,
        "provider": "google",
        "summary": f"Event {event_id}",
        "start": start,
        "end": start + timedelta(hours=1),
        "time_zone": "Europe/Berlin",
        "updated": UPDATED,
    }
    fields.update(overrides)
    return Event(**fields)  # type: ignore[arg-type]


def _calendar(calendar_id: str = CALENDAR_ID) -> Calendar:
    return Calendar(
        id=calendar_id,
        provider="google",
        name="Primary",
        time_zone="Europe/Berlin",
        is_primary=True,
        color="#3366ff",
    )


def _credential(provider: str = "google") -> StoredCredential:
    return StoredCredential(
        metadata=CredentialMetadata(
            provider=provider,
            key_id="v1",
            scopes=(),
            access_expires_at=None,
            refresh_expires_at=None,
            has_refresh_token=False,
            created_at=UPDATED,
            updated_at=UPDATED,
        ),
        tokens=TokenBundle(access_token="fake-access-token"),
    )


def _seeded(*event_ids: str, page_size: int = 100, provider: str = "google") -> FakeCalendarAdapter:
    adapter = FakeCalendarAdapter(provider=provider, page_size=page_size)
    adapter.add_calendar(_calendar())
    for event_id in event_ids:
        adapter.add_event(_event(event_id))
    return adapter


async def _drain(
    adapter: FakeCalendarAdapter,
    *,
    cursor: str | None = None,
    page_size: int | None = None,
) -> tuple[list[Event], list[EventDeletion], str | None, int]:
    events: list[Event] = []
    deletions: list[EventDeletion] = []
    page_token: str | None = None
    pages = 0
    while True:
        page = await adapter.list_events(
            CALENDAR_ID, cursor=cursor, page_token=page_token, page_size=page_size
        )
        events.extend(page.events)
        deletions.extend(page.deletions)
        pages += 1
        if not page.has_more:
            return events, deletions, page.next_cursor, pages
        page_token = page.next_page_token


# --- the fake satisfies the contract ---------------------------------------


def test_fake_satisfies_the_adapter_contract() -> None:
    fake = FakeCalendarAdapter(provider="google")
    assert isinstance(fake, CalendarAdapter)
    assert fake.provider == "google"
    assert fake.cursor_type is CursorType.SYNC_TOKEN


async def test_list_calendars_returns_seeded_calendars() -> None:
    adapter = FakeCalendarAdapter(provider="google")
    adapter.add_calendar(_calendar("cal-b"))
    adapter.add_calendar(_calendar("cal-a"))
    calendars = await adapter.list_calendars()
    assert [calendar.id for calendar in calendars] == ["cal-a", "cal-b"]


# --- pagination ------------------------------------------------------------


async def test_paging_walks_every_event_without_gaps_or_duplicates() -> None:
    adapter = _seeded(*[f"e{i}" for i in range(5)], page_size=2)
    events, deletions, cursor, pages = await _drain(adapter, page_size=2)
    assert [event.id for event in events] == ["e0", "e1", "e2", "e3", "e4"]
    assert len({event.id for event in events}) == 5  # no duplicates
    assert deletions == []
    assert pages == 3
    assert cursor == adapter.current_cursor()


async def test_only_the_final_page_carries_the_durable_cursor() -> None:
    adapter = _seeded("e0", "e1", "e2", page_size=1)
    first = await adapter.list_events(CALENDAR_ID, page_size=1)
    assert first.has_more is True
    assert first.next_page_token is not None
    assert first.next_cursor is None

    second = await adapter.list_events(CALENDAR_ID, page_token=first.next_page_token, page_size=1)
    assert second.has_more is True
    assert second.next_cursor is None

    final = await adapter.list_events(CALENDAR_ID, page_token=second.next_page_token, page_size=1)
    assert final.has_more is False
    assert final.next_page_token is None
    assert final.next_cursor == adapter.current_cursor()


async def test_event_page_has_more_tracks_the_page_token() -> None:
    assert EventPage().has_more is False
    assert EventPage(next_page_token="3:2").has_more is True


# --- incremental cursors ---------------------------------------------------


async def test_incremental_cursor_returns_only_changes_since_the_cursor() -> None:
    adapter = _seeded("e0", "e1")
    _, _, cursor, _ = await _drain(adapter)
    assert cursor is not None

    adapter.add_event(_event("e2"))  # created
    adapter.update_event(_event("e0", start_hour=11))  # changed
    adapter.delete_event("e1", CALENDAR_ID)  # removed

    events, deletions, next_cursor, _ = await _drain(adapter, cursor=cursor)
    assert {event.id for event in events} == {"e0", "e2"}
    assert [deletion.id for deletion in deletions] == ["e1"]
    assert next_cursor is not None
    assert next_cursor != cursor


async def test_incremental_cursor_does_not_repeat_an_unchanged_event() -> None:
    adapter = _seeded("e0")
    _, _, cursor, _ = await _drain(adapter)
    assert cursor is not None
    events, deletions, next_cursor, _ = await _drain(adapter, cursor=cursor)
    assert events == []
    assert deletions == []
    # The cursor still advances, so the sync layer can record a successful no-op pass.
    assert next_cursor == cursor


async def test_deletions_are_surfaced_as_tombstones() -> None:
    adapter = _seeded("e0")
    _, _, cursor, _ = await _drain(adapter)
    assert cursor is not None
    adapter.delete_event("e0", CALENDAR_ID, recurrence_id="2026-10-27T09:00:00Z")

    _, deletions, _, _ = await _drain(adapter, cursor=cursor)
    assert len(deletions) == 1
    tombstone = deletions[0]
    assert tombstone.id == "e0"
    assert tombstone.calendar_id == CALENDAR_ID
    assert tombstone.provider == "google"
    assert tombstone.recurrence_id == "2026-10-27T09:00:00Z"


async def test_a_change_made_during_paging_is_deferred_not_skipped() -> None:
    adapter = _seeded("e0", "e1", "e2", "e3", page_size=2)
    first = await adapter.list_events(CALENDAR_ID, page_size=2)
    cursor_at_start = adapter.current_cursor()

    adapter.add_event(_event("e4"))  # lands while the caller is mid-pass

    page_token = first.next_page_token
    assert page_token is not None
    saw: list[str] = [event.id for event in first.events]
    while page_token is not None:
        page = await adapter.list_events(CALENDAR_ID, page_token=page_token, page_size=2)
        saw.extend(event.id for event in page.events)
        page_token = page.next_page_token
    assert saw == ["e0", "e1", "e2", "e3"]  # e4 is not in this pass

    # The pass returns the revision it started at, so e4 is picked up by the *next* pass.
    events, _, _, _ = await _drain(adapter, cursor=cursor_at_start)
    assert [event.id for event in events] == ["e4"]


async def test_paging_an_unknown_calendar_is_rejected() -> None:
    adapter = FakeCalendarAdapter(provider="google")
    with pytest.raises(ValueError, match="unknown calendar"):
        await adapter.list_events("missing")


# --- the neutral event model ----------------------------------------------


async def test_neutral_event_carries_all_day_zone_recurrence_and_etag() -> None:
    adapter = FakeCalendarAdapter(provider="microsoft", page_size=100)
    adapter.add_calendar(_calendar())
    all_day = _event(
        "series-1",
        start_hour=0,
        provider="microsoft",
        is_all_day=True,
        time_zone="America/New_York",
        status=EventStatus.TENTATIVE,
        etag="etag-7",
        recurrence_id="2026-10-27",
        recurrence_rule="FREQ=DAILY;COUNT=5",
        ical_uid="series-1@atlas",
    )
    adapter.add_event(all_day)

    page = await adapter.list_events(CALENDAR_ID)
    assert page.has_more is False
    event = page.events[0]
    assert event.is_all_day is True
    assert event.time_zone == "America/New_York"
    assert event.recurrence_id == "2026-10-27"
    assert event.recurrence_rule == "FREQ=DAILY;COUNT=5"
    assert event.etag == "etag-7"
    assert event.status is EventStatus.TENTATIVE
    assert event.provider == "microsoft"
    assert event.updated == UPDATED


def test_neutral_event_rejects_naive_instants() -> None:
    with pytest.raises(ValueError, match="timezone-aware"):
        _event("naive", start=datetime(2026, 10, 27, 9, 0))


def test_neutral_event_rejects_an_end_before_the_start() -> None:
    start = datetime(2026, 10, 27, 9, 0, tzinfo=UTC)
    with pytest.raises(ValueError, match="end must not be before start"):
        _event("backwards", start=start, end=start - timedelta(hours=1))


def test_cursor_type_classifies_the_provider_cursor() -> None:
    assert CursorType.SYNC_TOKEN.value == "sync_token"
    assert CursorType.DELTA_LINK.value == "delta_link"


# --- the registry / factory ------------------------------------------------


def test_registry_returns_the_adapter_registered_for_a_provider() -> None:
    fake = FakeCalendarAdapter(provider="google")
    registry = AdapterRegistry()
    registry.register("google", fake_adapter_factory(fake))

    assert registry.create("google", _credential()) is fake
    assert registry.providers() == ("google",)
    assert "google" in registry
    assert "microsoft" not in registry


def test_registry_rejects_an_unknown_provider() -> None:
    registry = AdapterRegistry()
    registry.register("google", fake_adapter_factory(FakeCalendarAdapter(provider="google")))
    with pytest.raises(UnknownProviderError) as excinfo:
        registry.create("microsoft", _credential("microsoft"))
    assert excinfo.value.provider == "microsoft"
    assert "microsoft" in str(excinfo.value)
    assert "google" in str(excinfo.value)  # the message names the known providers


def test_an_empty_registry_rejects_every_provider() -> None:
    registry = AdapterRegistry()
    assert registry.providers() == ()
    with pytest.raises(UnknownProviderError):
        registry.create("google", _credential())


def test_registry_canonicalises_provider_names() -> None:
    fake = FakeCalendarAdapter(provider="google")
    registry = AdapterRegistry()
    registry.register(" GOOGLE ", fake_adapter_factory(fake))
    assert registry.providers() == ("google",)
    assert registry.create("Google", _credential()) is fake


def test_registry_refuses_to_silently_replace_a_registration() -> None:
    registry = AdapterRegistry()
    first = FakeCalendarAdapter(provider="google")
    second = FakeCalendarAdapter(provider="google")
    registry.register("google", fake_adapter_factory(first))
    with pytest.raises(AdapterError, match="already registered"):
        registry.register("google", fake_adapter_factory(second))
    registry.register("google", fake_adapter_factory(second), replace=True)
    assert registry.create("google", _credential()) is second


def test_build_adapter_uses_an_explicit_registry() -> None:
    fake = FakeCalendarAdapter(provider="google")
    registry = AdapterRegistry()
    registry.register("google", fake_adapter_factory(fake))
    assert build_adapter("google", _credential(), registry=registry) is fake


def test_the_default_registry_starts_empty() -> None:
    # Real adapters register into it in M5-03/M5-04; nothing is registered yet (M5-00 is BLOCKED).
    assert default_registry().providers() == ()


def test_canonical_provider_normalises_and_rejects_blank() -> None:
    assert canonical_provider("  Google ") == "google"
    assert canonical_provider(CredentialProvider.GOOGLE) == "google"
    with pytest.raises(UnknownProviderError):
        canonical_provider("   ")


# --- no provider SDK leaks into the contract -------------------------------

_SDK_ROOTS = {"google", "googleapiclient", "oauth2client", "msgraph", "msgraphsdk", "microsoft"}


def _imported_roots(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    roots: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            roots.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            roots.add(node.module.split(".")[0])
    return roots


def test_the_contract_modules_import_no_provider_sdk() -> None:
    import atlas.calendar.adapter as adapter_module
    import atlas.calendar.fake as fake_module
    import atlas.calendar.types as types_module

    for module in (adapter_module, fake_module, types_module):
        assert module.__file__ is not None
        assert not (_imported_roots(Path(module.__file__)) & _SDK_ROOTS), module.__name__
