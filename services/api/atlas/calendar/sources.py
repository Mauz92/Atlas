"""Calendar sources: discovery, selection, ICS feeds and disconnect (M5-05, M5-11, ADR-0071).

A *source* is one displayable calendar (``calendar_sources``). Provider calendars are discovered
from the connected account and keep the user's choices across re-discovery; an ICS feed source holds
its secret URL sealed with the credential cipher (AES-GCM, bound to the user and the row), masked
in every response. Everything is strictly user-scoped (another user's id is a plain "not found").

**Disconnect semantics (ADR-0071 D8).** Projected events are a *cache* of provider-owned data, not
Atlas-authored content, so disconnecting a provider (or removing a feed) **deletes** its projected
events, sync cursors and source rows and the stored credential; reconnecting re-syncs from scratch.
Hiding a calendar (``selected = false``) is different: it keeps the projection and the cursor and
only
stops syncing and display, so showing it again resumes cheaply. Nothing here writes to a provider.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import CalendarSource, ExternalEvent, ProviderCredential, SyncCursor
from .adapter import CalendarAdapter
from .crypto import DecryptionError, TokenCipher, get_token_cipher
from .ics import ICS, IcsFeedAdapter
from .netguard import UnsafeUrlError, mask_feed_url, parse_feed_url
from .types import Calendar

PALETTE = tuple(str(n) for n in range(1, 9))
MAX_FEEDS = 20
MAX_NAME_LENGTH = 200


class SourceError(Exception):
    """A source operation was refused; ``code`` is stable and the message is user-safe."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class SourceNotFoundError(SourceError):
    def __init__(self) -> None:
        super().__init__("not_found", "Not found")


def _clean_color(color: str | None) -> str | None:
    if color is None:
        return None
    if color not in PALETTE:
        raise SourceError("invalid_color", "colour must be one of the palette values 1-8")
    return color


def _clean_name(name: str) -> str:
    cleaned = " ".join(name.split())
    if not cleaned:
        raise SourceError("invalid_name", "a name is required")
    return cleaned[:MAX_NAME_LENGTH]


class CalendarSourceService:
    def __init__(
        self, session: AsyncSession, user_id: uuid.UUID, *, cipher: TokenCipher | None = None
    ) -> None:
        self.session = session
        self.user_id = user_id
        self._cipher = cipher or get_token_cipher()

    # --- reading --------------------------------------------------------------

    async def list_sources(self, provider: str | None = None) -> list[CalendarSource]:
        statement = select(CalendarSource).where(CalendarSource.user_id == self.user_id)
        if provider is not None:
            statement = statement.where(CalendarSource.provider == provider)
        rows = await self.session.scalars(
            statement.order_by(
                CalendarSource.provider,
                CalendarSource.is_primary.desc(),
                CalendarSource.name,
                CalendarSource.id,
            )
        )
        return [*rows]

    async def selected(self, provider: str) -> list[CalendarSource]:
        return [row for row in await self.list_sources(provider) if row.selected]

    async def get(self, source_id: uuid.UUID) -> CalendarSource:
        row = await self.session.scalar(
            select(CalendarSource).where(
                CalendarSource.id == source_id, CalendarSource.user_id == self.user_id
            )
        )
        if row is None:
            raise SourceNotFoundError
        return row

    # --- provider discovery ---------------------------------------------------

    async def discover(self, provider: str, adapter: CalendarAdapter) -> list[CalendarSource]:
        """Upsert the account's calendars. New ones get a default selection and the next colour;
        existing ones keep ``selected``/``color``. Calendars the provider no longer lists are
        removed together with their projection."""
        calendars: Sequence[Calendar] = await adapter.list_calendars()
        existing = {row.external_id: row for row in await self.list_sources(provider)}
        seen: set[str] = set()
        taken = len(existing)
        for calendar in calendars:
            seen.add(calendar.id)
            row = existing.get(calendar.id)
            if row is None:
                self.session.add(
                    CalendarSource(
                        user_id=self.user_id,
                        provider=provider,
                        external_id=calendar.id,
                        name=_clean_name(calendar.name),
                        color=PALETTE[taken % len(PALETTE)],
                        time_zone=calendar.time_zone,
                        is_read_only=calendar.is_read_only,
                        is_primary=calendar.is_primary,
                        selected=calendar.is_primary or not calendar.is_read_only,
                    )
                )
                taken += 1
            else:
                row.name = _clean_name(calendar.name)
                row.time_zone = calendar.time_zone
                row.is_read_only = calendar.is_read_only
                row.is_primary = calendar.is_primary
        for external_id, row in existing.items():
            if external_id not in seen:
                await self._purge_projection(provider, [external_id])
                await self.session.delete(row)
        await self.session.flush()
        return await self.list_sources(provider)

    # --- user choices ---------------------------------------------------------

    async def update(
        self,
        source_id: uuid.UUID,
        *,
        selected: bool | None = None,
        color: str | None = None,
        name: str | None = None,
    ) -> CalendarSource:
        row = await self.get(source_id)
        if selected is not None:
            row.selected = selected
        if color is not None:
            row.color = _clean_color(color)
        if name is not None:
            if row.provider != ICS:
                raise SourceError(
                    "name_fixed", "a provider calendar's name comes from the provider"
                )
            row.name = _clean_name(name)
        await self.session.flush()
        return row

    # --- ICS feeds ------------------------------------------------------------

    def _aad(self, source_id: uuid.UUID) -> bytes:
        return f"ics-feed:{self.user_id}:{source_id}".encode()

    async def add_feed(self, *, url: str, name: str, color: str | None = None) -> CalendarSource:
        """Store a new feed. The URL is validated syntactically here; the network check (resolution,
        private-address refusal) happens on every fetch, so a later DNS change cannot bypass it."""
        try:
            parts = parse_feed_url(url)
        except UnsafeUrlError as exc:
            raise SourceError(exc.code, str(exc)) from exc
        normalised = parts._replace(scheme=parts.scheme.lower()).geturl()
        count = await self.session.scalar(
            select(func.count())
            .select_from(CalendarSource)
            .where(CalendarSource.user_id == self.user_id, CalendarSource.provider == ICS)
        )
        if (count or 0) >= MAX_FEEDS:
            raise SourceError("too_many_feeds", f"at most {MAX_FEEDS} feeds can be added")
        source_id = uuid.uuid4()
        taken = await self.session.scalar(
            select(func.count())
            .select_from(CalendarSource)
            .where(CalendarSource.user_id == self.user_id)
        )
        row = CalendarSource(
            id=source_id,
            user_id=self.user_id,
            provider=ICS,
            external_id=str(source_id),
            name=_clean_name(name),
            color=_clean_color(color) or PALETTE[(taken or 0) % len(PALETTE)],
            time_zone="UTC",
            is_read_only=True,
            is_primary=False,
            selected=True,
            feed_url_ciphertext=self._cipher.encrypt(
                normalised.encode("utf-8"), aad=self._aad(source_id)
            ),
            feed_url_key_id=self._cipher.active_key_id,
            feed_url_display=mask_feed_url(normalised),
        )
        self.session.add(row)
        await self.session.flush()
        return row

    def feed_url(self, row: CalendarSource) -> str:
        """The decrypted feed URL (in-process only; never serialised, never logged)."""
        if row.provider != ICS or row.feed_url_ciphertext is None or row.feed_url_key_id is None:
            raise SourceError("not_a_feed", "this calendar is not a feed")
        try:
            return self._cipher.decrypt(
                row.feed_url_ciphertext, key_id=row.feed_url_key_id, aad=self._aad(row.id)
            ).decode("utf-8")
        except DecryptionError as exc:
            raise SourceError("undecryptable", "the stored feed link could not be read") from exc

    def ics_adapter(self, row: CalendarSource) -> IcsFeedAdapter:
        return IcsFeedAdapter(
            feed_id=row.external_id, url=self.feed_url(row), name=row.name, time_zone=row.time_zone
        )

    async def remove_feed(self, source_id: uuid.UUID) -> None:
        row = await self.get(source_id)
        if row.provider != ICS:
            raise SourceError(
                "not_a_feed", "only feeds can be removed; disconnect the account instead"
            )
        await self._purge_projection(ICS, [row.external_id])
        await self.session.delete(row)
        await self.session.flush()

    # --- disconnect -----------------------------------------------------------

    async def disconnect(self, provider: str) -> dict[str, int]:
        """Delete the provider's credential, sources, cursors and projected events (see module
        doc)."""
        sources = await self.list_sources(provider)
        events = await self._purge_projection(provider, [row.external_id for row in sources])
        # Cursors / events of calendars that no longer have a source row go too.
        await self.session.execute(
            delete(SyncCursor).where(
                SyncCursor.user_id == self.user_id, SyncCursor.provider == provider
            )
        )
        removed = await self.session.execute(
            delete(ExternalEvent).where(
                ExternalEvent.user_id == self.user_id, ExternalEvent.provider == provider
            )
        )
        for row in sources:
            await self.session.delete(row)
        await self.session.execute(
            delete(ProviderCredential).where(
                ProviderCredential.user_id == self.user_id, ProviderCredential.provider == provider
            )
        )
        await self.session.flush()
        return {
            "calendars": len(sources),
            "events": events + int(getattr(removed, "rowcount", 0) or 0),
        }

    async def _purge_projection(self, provider: str, calendar_ids: list[str]) -> int:
        if not calendar_ids:
            return 0
        removed = await self.session.execute(
            delete(ExternalEvent).where(
                ExternalEvent.user_id == self.user_id,
                ExternalEvent.provider == provider,
                ExternalEvent.calendar_id.in_(calendar_ids),
            )
        )
        await self.session.execute(
            delete(SyncCursor).where(
                SyncCursor.user_id == self.user_id,
                SyncCursor.provider == provider,
                SyncCursor.calendar_id.in_(calendar_ids),
            )
        )
        return int(getattr(removed, "rowcount", 0) or 0)
