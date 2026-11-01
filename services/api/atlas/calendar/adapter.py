"""The provider-neutral calendar adapter contract and registry (M5-02).

Everything the synchronisation layer needs from a calendar provider is expressed here, and nothing
provider-specific leaks through it (AGENTS.md §7.3, ARCHITECTURE §4). A Google adapter (M5-03) and a
Microsoft Graph adapter (M5-04) will each implement :class:`CalendarAdapter` using these neutral
types; the sync layer (M5-06) depends only on the protocol and the value objects in
:mod:`atlas.calendar.types`.

The contract has exactly three responsibilities:

- enumerate the calendars an account exposes (:meth:`CalendarAdapter.list_calendars`);
- list events for one calendar, with **pagination** and **incremental cursors**, surfacing deletions
  as tombstones (:meth:`CalendarAdapter.list_events`);
- declare the kind of incremental cursor it issues (:attr:`CalendarAdapter.cursor_type`) so the sync
  layer persists it correctly (DATA_MODEL.md §2.4 ``SyncCursor``).

Errors are reported through the taxonomy in :mod:`atlas.calendar.errors`; an adapter never lets a
provider SDK exception escape.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import Protocol, runtime_checkable

from .errors import AdapterError, UnknownProviderError
from .tokens import StoredCredential
from .types import Calendar, CursorType, EventPage


@runtime_checkable
class CalendarAdapter(Protocol):
    """A calendar provider behind a stable, provider-neutral interface.

    Implementations are selected by provider name via :class:`AdapterRegistry`. The protocol is
    structural, so an adapter need only *provide* these members — it does not have to inherit from
    anything.
    """

    @property
    def provider(self) -> str:
        """The canonical provider name this adapter serves (e.g. ``"google"``)."""
        ...

    @property
    def cursor_type(self) -> CursorType:
        """The kind of durable incremental cursor :meth:`list_events` returns."""
        ...

    async def list_calendars(self) -> Sequence[Calendar]:
        """The calendars available for the connected account."""
        ...

    async def list_events(
        self,
        calendar_id: str,
        *,
        cursor: str | None = None,
        page_token: str | None = None,
        page_size: int | None = None,
    ) -> EventPage:
        """List events for ``calendar_id``, one page at a time.

        ``cursor`` selects the mode: ``None`` lists the current events (an initial/full sync);
        otherwise only changes since that durable cursor are returned. ``page_token`` continues a
        previous call — the caller passes the same ``cursor`` back with each new page token. The
        final page carries :attr:`EventPage.next_cursor`, which must only be persisted once every
        change in the call has been committed (CALENDAR_SYNC §4).
        """
        ...


#: Builds an adapter from the account's stored credential (tokens are read by the caller).
AdapterFactory = Callable[[StoredCredential], CalendarAdapter]


def canonical_provider(provider: str) -> str:
    """Normalise a provider name (accepting a ``StrEnum`` value) for registry lookups."""
    candidate = getattr(provider, "value", provider)
    if not isinstance(candidate, str) or not candidate.strip():
        raise UnknownProviderError(str(provider))
    return candidate.strip().lower()


class AdapterRegistry:
    """Selects a :class:`CalendarAdapter` by provider name.

    A registry is populated by the adapter modules (M5-03/M5-04): each registers a factory keyed by
    its provider name. Requesting a provider that was never registered raises
    :class:`~atlas.calendar.errors.UnknownProviderError`, naming the providers that *are* known, so
    a typo or an unbuilt provider fails clearly at this seam.
    """

    def __init__(self) -> None:
        self._factories: dict[str, AdapterFactory] = {}

    def register(self, provider: str, factory: AdapterFactory, *, replace: bool = False) -> None:
        """Register ``factory`` for ``provider``.

        Registering the same provider twice is an error unless ``replace=True`` (which exists so a
        test can substitute a fake for a real adapter), preventing an accidental silent override.
        """
        key = canonical_provider(provider)
        if key in self._factories and not replace:
            raise AdapterError(f"a calendar adapter is already registered for provider {key!r}")
        self._factories[key] = factory

    def create(self, provider: str, credential: StoredCredential) -> CalendarAdapter:
        """Build the adapter registered for ``provider`` from ``credential``."""
        key = canonical_provider(provider)
        factory = self._factories.get(key)
        if factory is None:
            raise UnknownProviderError(str(provider), known=self.providers())
        return factory(credential)

    def providers(self) -> tuple[str, ...]:
        """The provider names that currently have an adapter, sorted."""
        return tuple(sorted(self._factories))

    def __contains__(self, provider: object) -> bool:
        if not isinstance(provider, str):
            return False
        return provider.strip().lower() in self._factories


#: The process-wide registry real adapters register into (empty until M5-03/M5-04).
_DEFAULT_REGISTRY = AdapterRegistry()


def default_registry() -> AdapterRegistry:
    """The shared registry that adapter modules register their factories into."""
    return _DEFAULT_REGISTRY


def build_adapter(
    provider: str, credential: StoredCredential, *, registry: AdapterRegistry | None = None
) -> CalendarAdapter:
    """Build the adapter for ``provider`` from the shared registry (or an explicit one)."""
    return (registry if registry is not None else _DEFAULT_REGISTRY).create(provider, credential)
