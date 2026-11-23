"""Campaigns and sessions (TTRPG-02).

Rules this module keeps:

* Prose lives in Markdown notes created through :class:`NotesService`; rows here only reference a
  note by its stable id, so renaming or moving a note never breaks the association.
* A note that was deleted is reported as *missing* (``NoteLinkState.missing``) and can be relinked
  to another note or recreated; the campaign and its history are never lost with it.
* Scaffolding is retry-safe: a note path that already holds a live note or a file is *adopted*,
  never overwritten, so retrying a create that failed half-way cannot clobber text a person edited.
* Everything is scoped to the owner; a foreign id is indistinguishable from a missing one.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Literal

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import NoteIndex, TtrpgCampaign, TtrpgSession
from ..models.ttrpg import RULES_PRESETS, SESSION_STATUSES
from ..notes import (
    NoteNotFoundError,
    NotesService,
    NotesStorage,
    NoteSummary,
    UnsafePathError,
    normalize_rel_path,
)
from .templates import HANDOFF_HEADING, extract_section, home_note, session_note

MAX_TITLE = 200
DEFAULT_ROOT = "TTRPG"
SESSIONS_DIR = "Sessions"
HOME_FILE = "Campaign Home"

_UNSAFE_CHARS = re.compile(r'[\\/:*?"<>|\x00-\x1f]+')


class CampaignNotFoundError(LookupError):
    pass


class SessionNotFoundError(LookupError):
    pass


class CampaignValidationError(ValueError):
    pass


class CampaignFolderTakenError(RuntimeError):
    """Another campaign of the same owner already uses this note folder."""


class CampaignIdTakenError(RuntimeError):
    """A client-chosen id belongs to a record of another account."""


class CampaignRevisionError(RuntimeError):
    def __init__(self, current_revision: int) -> None:
        super().__init__("changed since it was read")
        self.current_revision = current_revision


@dataclass(frozen=True)
class NoteLinkState:
    note_id: uuid.UUID | None
    path: str | None
    title: str | None
    missing: bool


@dataclass(frozen=True)
class PreviousHandoff:
    session_id: uuid.UUID
    title: str
    note: NoteLinkState
    handoff: str | None


@dataclass(frozen=True)
class SessionView:
    session: TtrpgSession
    note: NoteLinkState
    previous: PreviousHandoff | None = None


NoteKind = Literal["home", "session", "npc", "location", "other"]
NPC_DIR = "NPCs"
LOCATION_DIR = "Locations"


@dataclass(frozen=True)
class CampaignNote:
    id: uuid.UUID
    path: str
    title: str
    kind: NoteKind
    #: for a session note, its number and title ("1. Session 01"); otherwise ``None``
    label: str | None = None


@dataclass(frozen=True)
class CampaignView:
    campaign: TtrpgCampaign
    home: NoteLinkState
    sessions: list[SessionView]


def safe_name(value: str, fallback: str) -> str:
    """A single path segment derived from free text (never empty, never dotted-only)."""
    cleaned = _UNSAFE_CHARS.sub(" ", value).strip(" .")
    cleaned = re.sub(r"\s+", " ", cleaned)[:80].strip(" .")
    return cleaned or fallback


def _clean_title(value: str, field: str = "title") -> str:
    cleaned = " ".join(value.split())
    if not cleaned:
        raise CampaignValidationError(f"{field} must not be blank")
    if len(cleaned) > MAX_TITLE:
        raise CampaignValidationError(f"{field} must be at most {MAX_TITLE} characters")
    return cleaned


class CampaignService:
    def __init__(self, session: AsyncSession, user_id: uuid.UUID, storage: NotesStorage) -> None:
        self.session = session
        self.user_id = user_id
        self.storage = storage
        self.notes = NotesService(session, user_id, storage)

    # --- campaigns -------------------------------------------------------

    async def create_campaign(
        self,
        *,
        title: str,
        campaign_id: uuid.UUID | None = None,
        folder: str | None = None,
        book_title: str | None = None,
        rules_preset: str = "dnd5e-2014",
    ) -> tuple[TtrpgCampaign, bool]:
        """Create a campaign with a home note and a first session note.

        Returns ``(campaign, created)``. Retrying with the same ``campaign_id`` returns the
        existing campaign (``created=False``) after completing any missing scaffold.
        """
        if campaign_id is not None:
            existing = await self.session.get(TtrpgCampaign, campaign_id)
            if existing is not None:
                if existing.user_id != self.user_id:
                    raise CampaignIdTakenError(str(campaign_id))
                await self._complete_scaffold(existing)
                await self.session.flush()
                return existing, False

        title = _clean_title(title)
        if rules_preset not in RULES_PRESETS:
            raise CampaignValidationError(f"unknown rules preset {rules_preset!r}")
        book = _clean_title(book_title, "book title") if book_title and book_title.strip() else None
        folder_path = self._folder(folder, title)
        taken = await self.session.scalar(
            select(TtrpgCampaign.id).where(
                TtrpgCampaign.user_id == self.user_id, TtrpgCampaign.folder == folder_path
            )
        )
        if taken is not None:
            raise CampaignFolderTakenError(folder_path)

        campaign = TtrpgCampaign(
            id=campaign_id or uuid.uuid4(),
            user_id=self.user_id,
            title=title,
            book_title=book,
            rules_preset=rules_preset,
            folder=folder_path,
        )
        self.session.add(campaign)
        try:
            await self.session.flush()
        except IntegrityError as exc:
            raise CampaignFolderTakenError(folder_path) from exc
        await self._complete_scaffold(campaign)
        await self.session.flush()
        return campaign, True

    def _folder(self, folder: str | None, title: str) -> str:
        raw = (
            folder
            if folder and folder.strip()
            else f"{DEFAULT_ROOT}/{safe_name(title, 'Campaign')}"
        )
        try:
            normalized = normalize_rel_path(raw)
            if not normalized:
                raise CampaignValidationError("folder must not be empty")
            # validates traversal and the reserved directory
            self.storage.absolute(f"{normalized}/{HOME_FILE}.md")
        except UnsafePathError as exc:
            raise CampaignValidationError(str(exc)) from exc
        if len(normalized) > 400:
            raise CampaignValidationError("folder is too long")
        return normalized

    async def _complete_scaffold(self, campaign: TtrpgCampaign) -> None:
        """Create what is missing: the home note and the first session. Never overwrites."""
        if campaign.home_note_id is None:
            home = await self._ensure_note(
                f"{campaign.folder}/{HOME_FILE}.md", home_note(campaign.title, campaign.book_title)
            )
            campaign.home_note_id = home.id
        has_session = await self.session.scalar(
            select(TtrpgSession.id).where(TtrpgSession.campaign_id == campaign.id).limit(1)
        )
        if has_session is None:
            await self._add_session(campaign, session_id=None, title=None)

    async def _ensure_note(self, path: str, content: str) -> NoteIndex:
        live = await self.notes.get_by_path(path)
        if live is not None:
            return live
        if self.storage.exists(path):
            return await self.notes.adopt(path)
        return await self.notes.create(path, content)

    async def list_campaigns(self, *, include_archived: bool = False) -> list[TtrpgCampaign]:
        stmt = select(TtrpgCampaign).where(TtrpgCampaign.user_id == self.user_id)
        if not include_archived:
            stmt = stmt.where(TtrpgCampaign.archived_at.is_(None))
        rows = await self.session.scalars(stmt.order_by(TtrpgCampaign.created_at.desc()))
        return list(rows)

    async def get_campaign(self, campaign_id: uuid.UUID, *, lock: bool = False) -> TtrpgCampaign:
        stmt = select(TtrpgCampaign).where(
            TtrpgCampaign.id == campaign_id, TtrpgCampaign.user_id == self.user_id
        )
        if lock:
            stmt = stmt.with_for_update().execution_options(populate_existing=True)
        campaign = await self.session.scalar(stmt)
        if campaign is None:
            raise CampaignNotFoundError(str(campaign_id))
        return campaign

    async def update_campaign(
        self,
        campaign_id: uuid.UUID,
        *,
        base_revision: int,
        title: str | None = None,
        book_title: str | Literal["__unset__"] | None = "__unset__",
        archived: bool | None = None,
    ) -> TtrpgCampaign:
        campaign = await self.get_campaign(campaign_id, lock=True)
        if campaign.revision != base_revision:
            raise CampaignRevisionError(campaign.revision)
        changed = False
        if title is not None:
            new_title = _clean_title(title)
            changed |= new_title != campaign.title
            campaign.title = new_title
        if book_title != "__unset__":
            new_book = (
                _clean_title(book_title, "book title")
                if book_title and book_title.strip()
                else None
            )
            changed |= new_book != campaign.book_title
            campaign.book_title = new_book
        if archived is not None and archived != (campaign.archived_at is not None):
            campaign.archived_at = datetime.now(UTC) if archived else None
            changed = True
        if changed:
            campaign.revision += 1
            await self.session.flush()
        return campaign

    async def campaign_view(self, campaign_id: uuid.UUID) -> CampaignView:
        campaign = await self.get_campaign(campaign_id)
        sessions = list(
            await self.session.scalars(
                select(TtrpgSession)
                .where(
                    TtrpgSession.campaign_id == campaign.id, TtrpgSession.user_id == self.user_id
                )
                .order_by(TtrpgSession.sequence)
            )
        )
        states = await self._link_states(
            [campaign.home_note_id, *[item.note_id for item in sessions]]
        )
        return CampaignView(
            campaign=campaign,
            home=states[campaign.home_note_id],
            sessions=[SessionView(item, states[item.note_id]) for item in sessions],
        )

    async def _link_states(
        self, note_ids: list[uuid.UUID | None]
    ) -> dict[uuid.UUID | None, NoteLinkState]:
        wanted = {note_id for note_id in note_ids if note_id is not None}
        found: dict[uuid.UUID, NoteIndex] = {}
        if wanted:
            rows = await self.session.scalars(
                select(NoteIndex).where(NoteIndex.id.in_(wanted), NoteIndex.user_id == self.user_id)
            )
            found = {row.id: row for row in rows}
        result: dict[uuid.UUID | None, NoteLinkState] = {
            None: NoteLinkState(None, None, None, True)
        }
        for note_id in wanted:
            note = found.get(note_id)
            if note is None or note.deleted_at is not None:
                result[note_id] = NoteLinkState(note_id, None, None, True)
            else:
                result[note_id] = NoteLinkState(note.id, note.path, note.title, False)
        return result

    # --- the campaign's notes, collected -------------------------------------

    async def campaign_notes(self, campaign_id: uuid.UUID) -> list[CampaignNote]:
        """Every note that belongs to the campaign, grouped for display.

        The notes stay ordinary notes in the notes tree, next to all the others. A note belongs here
        when it is linked as the home or a session note (wherever it now lives) or when its file is
        inside the campaign folder. Order: home, sessions by number, NPCs, locations, the rest.
        """
        campaign = await self.get_campaign(campaign_id)
        found = {n.id: n for n in await self.notes.list_notes(campaign.folder)}
        sessions = list(
            await self.session.scalars(
                select(TtrpgSession)
                .where(
                    TtrpgSession.campaign_id == campaign.id, TtrpgSession.user_id == self.user_id
                )
                .order_by(TtrpgSession.sequence)
            )
        )
        linked = {campaign.home_note_id} | {item.note_id for item in sessions}
        extra = [i for i in linked if i is not None and i not in found]
        for note_id in extra:
            try:
                live = await self.notes.get(note_id)
            except NoteNotFoundError:
                continue
            found[live.id] = await self._summary_of(live)

        out: list[CampaignNote] = []
        used: set[uuid.UUID] = set()
        if campaign.home_note_id in found:
            note = found[campaign.home_note_id]
            out.append(CampaignNote(note.id, note.path, note.title, "home"))
            used.add(note.id)
        for item in sessions:
            if item.note_id in found:
                note = found[item.note_id]
                out.append(
                    CampaignNote(
                        note.id, note.path, note.title, "session", f"{item.sequence}. {item.title}"
                    )
                )
                used.add(note.id)
        rest = [n for n in found.values() if n.id not in used]
        for kind, folder in (("npc", NPC_DIR), ("location", LOCATION_DIR)):
            prefix = f"{campaign.folder}/{folder}/"
            for note in sorted(
                (n for n in rest if n.path.startswith(prefix)), key=lambda n: n.title.casefold()
            ):
                out.append(CampaignNote(note.id, note.path, note.title, kind))  # type: ignore[arg-type]
                used.add(note.id)
        for note in sorted((n for n in rest if n.id not in used), key=lambda n: n.path.casefold()):
            out.append(CampaignNote(note.id, note.path, note.title, "other"))
        return out

    async def _summary_of(self, note: NoteIndex) -> NoteSummary:
        return NoteSummary(
            id=note.id,
            path=note.path,
            title=note.title,
            revision=note.revision,
            content_hash=note.content_hash,
            size_bytes=note.size_bytes,
        )

    async def create_campaign_note(
        self, campaign_id: uuid.UUID, *, kind: Literal["npc", "location", "note"], title: str
    ) -> CampaignNote:
        """A new note inside the campaign folder (NPCs/, Locations/ or the folder itself)."""
        campaign = await self.get_campaign(campaign_id)
        if campaign.archived_at is not None:
            raise CampaignValidationError("an archived campaign cannot get new notes")
        name = _clean_title(title)
        folder, sections = {
            "npc": (f"{campaign.folder}/{NPC_DIR}", ("Who they are", "What they want", "Notes")),
            "location": (
                f"{campaign.folder}/{LOCATION_DIR}",
                ("What it looks like", "Who is here", "Notes"),
            ),
            "note": (campaign.folder, ("Notes",)),
        }[kind]
        path = await self._unused_path(f"{folder}/{safe_name(name, 'Untitled')}")
        content = "\n".join(
            [f"# {name}", ""] + [line for h in sections for line in (f"## {h}", "")]
        )
        created = await self.notes.create(path, content)
        return CampaignNote(
            created.id,
            created.path,
            created.title,
            "npc" if kind == "npc" else "location" if kind == "location" else "other",
        )

    # --- sessions --------------------------------------------------------

    async def add_session(
        self,
        campaign_id: uuid.UUID,
        *,
        session_id: uuid.UUID | None = None,
        title: str | None = None,
    ) -> tuple[TtrpgSession, bool]:
        campaign = await self.get_campaign(campaign_id, lock=True)
        if session_id is not None:
            existing = await self.session.get(TtrpgSession, session_id)
            if existing is not None:
                if existing.user_id != self.user_id or existing.campaign_id != campaign.id:
                    raise CampaignIdTakenError(str(session_id))
                return existing, False
        if campaign.archived_at is not None:
            raise CampaignValidationError("an archived campaign cannot get new sessions")
        return await self._add_session(campaign, session_id=session_id, title=title), True

    async def _add_session(
        self, campaign: TtrpgCampaign, *, session_id: uuid.UUID | None, title: str | None
    ) -> TtrpgSession:
        last = await self.session.scalar(
            select(TtrpgSession)
            .where(TtrpgSession.campaign_id == campaign.id)
            .order_by(TtrpgSession.sequence.desc())
            .limit(1)
        )
        sequence = (last.sequence if last else 0) + 1
        name = _clean_title(title) if title and title.strip() else f"Session {sequence:02d}"
        left_off: str | None = None
        if last is not None:
            previous = await self._previous_handoff(last)
            left_off = previous.handoff if previous else None
        path = await self._unused_path(
            f"{campaign.folder}/{SESSIONS_DIR}/{safe_name(name, f'Session {sequence:02d}')}"
        )
        note = await self._ensure_note(path, session_note(name, left_off))
        row = TtrpgSession(
            id=session_id or uuid.uuid4(),
            campaign_id=campaign.id,
            user_id=self.user_id,
            note_id=note.id,
            title=name,
            sequence=sequence,
        )
        self.session.add(row)
        await self.session.flush()
        return row

    async def _unused_path(self, stem: str) -> str:
        """``stem.md``, else ``stem (2).md`` ... : the first path not held by a real note.

        A file with no index row is the leftover of an interrupted attempt (its transaction rolled
        back), so it is reused: ``_ensure_note`` adopts it rather than creating a duplicate.
        """
        for number in range(1, 1000):
            candidate = f"{stem}.md" if number == 1 else f"{stem} ({number}).md"
            if self.storage.exists(candidate) and await self.notes.get_by_path(candidate) is None:
                return candidate
            if not await self.notes.is_path_taken(candidate):
                return candidate
        raise CampaignValidationError("could not find a free note name")

    async def get_session(self, session_id: uuid.UUID, *, lock: bool = False) -> TtrpgSession:
        stmt = select(TtrpgSession).where(
            TtrpgSession.id == session_id, TtrpgSession.user_id == self.user_id
        )
        if lock:
            stmt = stmt.with_for_update().execution_options(populate_existing=True)
        row = await self.session.scalar(stmt)
        if row is None:
            raise SessionNotFoundError(str(session_id))
        return row

    async def session_view(self, session_id: uuid.UUID) -> SessionView:
        row = await self.get_session(session_id)
        states = await self._link_states([row.note_id])
        previous_row = await self.session.scalar(
            select(TtrpgSession)
            .where(
                TtrpgSession.campaign_id == row.campaign_id, TtrpgSession.sequence < row.sequence
            )
            .order_by(TtrpgSession.sequence.desc())
            .limit(1)
        )
        previous = await self._previous_handoff(previous_row) if previous_row else None
        return SessionView(row, states[row.note_id], previous)

    async def _previous_handoff(self, row: TtrpgSession) -> PreviousHandoff:
        state = (await self._link_states([row.note_id]))[row.note_id]
        handoff: str | None = None
        if not state.missing and state.path is not None:
            try:
                content = self.storage.read(state.path).content
            except (FileNotFoundError, OSError, UnicodeDecodeError):
                content = None
            if content is not None:
                handoff = extract_section(content, HANDOFF_HEADING) or None
        return PreviousHandoff(row.id, row.title, state, handoff)

    async def update_session(
        self,
        session_id: uuid.UUID,
        *,
        base_revision: int,
        title: str | None = None,
        status: str | None = None,
        session_date: date | Literal["__unset__"] | None = "__unset__",
    ) -> TtrpgSession:
        row = await self.get_session(session_id, lock=True)
        await self.get_campaign(row.campaign_id, lock=True)
        if row.revision != base_revision:
            raise CampaignRevisionError(row.revision)
        changed = False
        if title is not None:
            new_title = _clean_title(title)
            changed |= new_title != row.title
            row.title = new_title
        if status is not None:
            if status not in SESSION_STATUSES:
                raise CampaignValidationError(f"unknown status {status!r}")
            if status == "active" and row.status != "active":
                other = await self.session.scalar(
                    select(func.count())
                    .select_from(TtrpgSession)
                    .where(
                        TtrpgSession.campaign_id == row.campaign_id,
                        TtrpgSession.status == "active",
                        TtrpgSession.id != row.id,
                    )
                )
                if other:
                    raise CampaignValidationError("another session of this campaign is active")
            changed |= status != row.status
            row.status = status
        if session_date != "__unset__":
            changed |= session_date != row.session_date
            row.session_date = session_date
        if changed:
            row.revision += 1
            await self.session.flush()
        return row

    # --- note links --------------------------------------------------------

    async def relink(
        self,
        campaign_id: uuid.UUID,
        *,
        target: Literal["home"] | uuid.UUID,
        note_id: uuid.UUID | None,
    ) -> None:
        """Point the home note (or one session) at an existing note, or recreate a missing one.

        ``note_id=None`` recreates the note at its standard path (never over an existing file).
        Only a *missing* link may be repaired; a healthy one is left alone.
        """
        campaign = await self.get_campaign(campaign_id, lock=True)
        row: TtrpgSession | None = None
        if target == "home":
            current = campaign.home_note_id
        else:
            row = await self.get_session(target, lock=True)
            if row.campaign_id != campaign.id:
                raise SessionNotFoundError(str(target))
            current = row.note_id
        state = (await self._link_states([current]))[current]
        if not state.missing:
            raise CampaignValidationError("this note link is not missing")

        if note_id is not None:
            note = await self.notes.get(note_id)  # NoteNotFoundError for foreign or deleted
            if await self._note_in_use(campaign, note.id):
                raise CampaignValidationError("that note is already used by this campaign")
            new_id = note.id
        elif target == "home":
            new_id = (
                await self._ensure_note(
                    await self._unused_path(f"{campaign.folder}/{HOME_FILE}"),
                    home_note(campaign.title, campaign.book_title),
                )
            ).id
        else:
            assert row is not None
            new_id = (
                await self._ensure_note(
                    await self._unused_path(
                        f"{campaign.folder}/{SESSIONS_DIR}/{safe_name(row.title, 'Session')}"
                    ),
                    session_note(row.title),
                )
            ).id
        if row is None:
            campaign.home_note_id = new_id
            campaign.revision += 1
        else:
            row.note_id = new_id
            row.revision += 1
        await self.session.flush()

    async def _note_in_use(self, campaign: TtrpgCampaign, note_id: uuid.UUID) -> bool:
        if campaign.home_note_id == note_id:
            return True
        used = await self.session.scalar(
            select(TtrpgSession.id).where(
                TtrpgSession.user_id == self.user_id, TtrpgSession.note_id == note_id
            )
        )
        return used is not None


__all__ = [
    "CampaignFolderTakenError",
    "CampaignIdTakenError",
    "CampaignNotFoundError",
    "CampaignRevisionError",
    "CampaignService",
    "CampaignValidationError",
    "CampaignView",
    "NoteLinkState",
    "NoteNotFoundError",
    "PreviousHandoff",
    "SessionNotFoundError",
    "SessionView",
]
