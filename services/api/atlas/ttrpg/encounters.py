"""Prepared encounters (TTRPG-05).

An encounter is *prep*: a title, optional book reference and setup reminder, the party members that
take part and a reusable lineup of **slots**. Each slot carries its own copy of the stats it was
made from, so:

* editing or archiving a creature card, or a catalogue outage, never changes or breaks an encounter;
* upstream/card changes reach a slot only through the explicit :meth:`EncounterService.refresh`,
  which never touches a field the DM set by hand (``overrides``) or a slot's name;
* several independent slots can come from one card (own name, own starting HP).

Every write is checked against the encounter's ``revision`` (slot edits bump it too), so a stale tab
gets a conflict instead of overwriting newer prep.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import (
    NoteIndex,
    TtrpgCampaign,
    TtrpgCreature,
    TtrpgEncounter,
    TtrpgEncounterSlot,
    TtrpgPartyMember,
    TtrpgSession,
)
from ..notes import NoteNotFoundError, NotesService, NotesStorage
from .campaigns import (
    CampaignIdTakenError,
    CampaignNotFoundError,
    CampaignRevisionError,
    NoteLinkState,
    SessionNotFoundError,
)
from .creatures import CreatureNotFoundError

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
Title = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
Reference = Annotated[str, StringConstraints(strip_whitespace=True, max_length=300)]
Reminder = Annotated[str, StringConstraints(strip_whitespace=True, max_length=2000)]

MAX_SLOTS = 60
MAX_PARTY = 12
OVERRIDABLE = ("name", "ac", "hp", "initiative_mod")
ENCOUNTER_PATH = "/ttrpg/encounters"


class EncounterNotFoundError(LookupError):
    pass


class SlotNotFoundError(LookupError):
    pass


class EncounterValidationError(ValueError):
    pass


class SlotSpec(BaseModel):
    """Add ``count`` independent slots, from a card or fully custom (name, AC and HP then)."""

    model_config = ConfigDict(extra="forbid")

    creature_id: uuid.UUID | None = None
    count: int = Field(default=1, ge=1, le=MAX_SLOTS)
    side: Literal["enemy", "ally"] = "enemy"
    name: Name | None = None
    ac: int | None = Field(default=None, ge=0, le=40)
    hp: int | None = Field(default=None, ge=1, le=9999)
    initiative_mod: int | None = Field(default=None, ge=-10, le=30)


class SlotChanges(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Name | None = None
    ac: int | None = Field(default=None, ge=0, le=40)
    hp: int | None = Field(default=None, ge=1, le=9999)
    initiative_mod: int | None = Field(default=None, ge=-10, le=30)
    side: Literal["enemy", "ally"] | None = None


@dataclass(frozen=True)
class SlotRefresh:
    slot_id: uuid.UUID
    name: str
    #: refreshed | unchanged | no_card | card_archived
    outcome: str


@dataclass(frozen=True)
class EncounterView:
    encounter: TtrpgEncounter
    slots: list[TtrpgEncounterSlot]
    party: list[tuple[TtrpgPartyMember, bool]]  # (member, missing-from-roster)
    session_title: str | None
    location: NoteLinkState | None


def snapshot_of(card: TtrpgCreature) -> dict[str, Any]:
    return {
        "creature_revision": card.revision,
        "name": card.name,
        "challenge_rating": card.challenge_rating,
        "size": card.size,
        "creature_type": card.creature_type,
        "speed": card.speed,
        "traits": list(card.traits),
        "actions": list(card.actions),
        "source": card.source,
        "source_edition": card.source_edition,
        "external_id": card.external_id,
        "attribution": card.attribution,
    }


def link_markdown(encounter_id: uuid.UUID, title: str) -> str:
    safe = re.sub(r"[\[\]\r\n]+", " ", title).strip() or "Encounter"
    return f"[{safe}]({ENCOUNTER_PATH}/{encounter_id})"


class EncounterService:
    def __init__(self, session: AsyncSession, user_id: uuid.UUID, storage: NotesStorage) -> None:
        self.session = session
        self.user_id = user_id
        self.storage = storage
        self.notes = NotesService(session, user_id, storage)

    # --- lookups -------------------------------------------------------------

    async def _campaign(self, campaign_id: uuid.UUID) -> TtrpgCampaign:
        campaign = await self.session.scalar(
            select(TtrpgCampaign).where(
                TtrpgCampaign.id == campaign_id, TtrpgCampaign.user_id == self.user_id
            )
        )
        if campaign is None:
            raise CampaignNotFoundError(str(campaign_id))
        return campaign

    async def get(self, encounter_id: uuid.UUID, *, lock: bool = False) -> TtrpgEncounter:
        stmt = select(TtrpgEncounter).where(
            TtrpgEncounter.id == encounter_id, TtrpgEncounter.user_id == self.user_id
        )
        if lock:
            stmt = stmt.with_for_update().execution_options(populate_existing=True)
        encounter = await self.session.scalar(stmt)
        if encounter is None:
            raise EncounterNotFoundError(str(encounter_id))
        return encounter

    async def _slots(self, encounter_id: uuid.UUID) -> list[TtrpgEncounterSlot]:
        rows = await self.session.scalars(
            select(TtrpgEncounterSlot)
            .where(
                TtrpgEncounterSlot.encounter_id == encounter_id,
                TtrpgEncounterSlot.user_id == self.user_id,
            )
            .order_by(TtrpgEncounterSlot.position)
        )
        return list(rows)

    async def list_encounters(
        self,
        campaign_id: uuid.UUID,
        *,
        session_id: uuid.UUID | None = None,
        include_archived: bool = False,
    ) -> list[tuple[TtrpgEncounter, int]]:
        await self._campaign(campaign_id)
        stmt = (
            select(TtrpgEncounter, func.count(TtrpgEncounterSlot.id))
            .outerjoin(TtrpgEncounterSlot, TtrpgEncounterSlot.encounter_id == TtrpgEncounter.id)
            .where(
                TtrpgEncounter.campaign_id == campaign_id, TtrpgEncounter.user_id == self.user_id
            )
            .group_by(TtrpgEncounter.id)
            .order_by(TtrpgEncounter.created_at, TtrpgEncounter.id)
        )
        if session_id is not None:
            stmt = stmt.where(TtrpgEncounter.session_id == session_id)
        if not include_archived:
            stmt = stmt.where(TtrpgEncounter.archived_at.is_(None))
        return [(e, int(n)) for e, n in (await self.session.execute(stmt)).all()]

    async def view(self, encounter_id: uuid.UUID) -> EncounterView:
        encounter = await self.get(encounter_id)
        slots = await self._slots(encounter.id)
        wanted = [uuid.UUID(i) for i in encounter.party_member_ids]
        found: dict[uuid.UUID, TtrpgPartyMember] = {}
        if wanted:
            rows = await self.session.scalars(
                select(TtrpgPartyMember).where(
                    TtrpgPartyMember.id.in_(wanted), TtrpgPartyMember.user_id == self.user_id
                )
            )
            found = {m.id: m for m in rows}
        party = [(found[i], found[i].archived_at is not None) for i in wanted if i in found]
        session_title: str | None = None
        if encounter.session_id is not None:
            session_title = await self.session.scalar(
                select(TtrpgSession.title).where(TtrpgSession.id == encounter.session_id)
            )
        location: NoteLinkState | None = None
        if encounter.location_note_id is not None:
            note = await self.session.scalar(
                select(NoteIndex).where(
                    NoteIndex.id == encounter.location_note_id, NoteIndex.user_id == self.user_id
                )
            )
            location = (
                NoteLinkState(encounter.location_note_id, None, None, True)
                if note is None or note.deleted_at is not None
                else NoteLinkState(note.id, note.path, note.title, False)
            )
        return EncounterView(encounter, slots, party, session_title, location)

    # --- validation helpers ------------------------------------------------------

    async def _check_session(self, campaign_id: uuid.UUID, session_id: uuid.UUID) -> None:
        owned = await self.session.scalar(
            select(TtrpgSession.id).where(
                TtrpgSession.id == session_id,
                TtrpgSession.campaign_id == campaign_id,
                TtrpgSession.user_id == self.user_id,
            )
        )
        if owned is None:
            raise SessionNotFoundError(str(session_id))

    async def _check_note(self, note_id: uuid.UUID) -> None:
        await self.notes.get(note_id)  # NoteNotFoundError for foreign or deleted notes

    async def _check_party(self, campaign_id: uuid.UUID, ids: list[uuid.UUID]) -> list[str]:
        unique = list(dict.fromkeys(ids))
        if len(unique) > MAX_PARTY:
            raise EncounterValidationError(f"at most {MAX_PARTY} party members")
        if unique:
            count = await self.session.scalar(
                select(func.count())
                .select_from(TtrpgPartyMember)
                .where(
                    TtrpgPartyMember.id.in_(unique),
                    TtrpgPartyMember.campaign_id == campaign_id,
                    TtrpgPartyMember.user_id == self.user_id,
                    TtrpgPartyMember.archived_at.is_(None),
                )
            )
            if count != len(unique):
                raise EncounterValidationError(
                    "party members must be active members of this campaign"
                )
        return [str(i) for i in unique]

    # --- encounters ------------------------------------------------------------

    async def create(
        self,
        campaign_id: uuid.UUID,
        *,
        title: str,
        encounter_id: uuid.UUID | None = None,
        book_reference: str | None = None,
        setup_reminder: str | None = None,
        session_id: uuid.UUID | None = None,
        location_note_id: uuid.UUID | None = None,
        party_member_ids: list[uuid.UUID] | None = None,
    ) -> tuple[TtrpgEncounter, bool]:
        campaign = await self._campaign(campaign_id)
        if encounter_id is not None:
            existing = await self.session.get(TtrpgEncounter, encounter_id)
            if existing is not None:
                if existing.user_id != self.user_id or existing.campaign_id != campaign.id:
                    raise CampaignIdTakenError(str(encounter_id))
                return existing, False
        if campaign.archived_at is not None:
            raise EncounterValidationError("an archived campaign cannot get new encounters")
        if session_id is not None:
            await self._check_session(campaign.id, session_id)
        if location_note_id is not None:
            await self._check_note(location_note_id)
        party = await self._check_party(campaign.id, party_member_ids or [])
        encounter = TtrpgEncounter(
            id=encounter_id or uuid.uuid4(),
            campaign_id=campaign.id,
            user_id=self.user_id,
            title=title,
            book_reference=book_reference or None,
            setup_reminder=setup_reminder or None,
            session_id=session_id,
            location_note_id=location_note_id,
            party_member_ids=party,
        )
        self.session.add(encounter)
        try:
            await self.session.flush()
        except IntegrityError as exc:
            raise CampaignIdTakenError(str(encounter_id)) from exc
        return encounter, True

    async def update(
        self, encounter_id: uuid.UUID, *, base_revision: int, changes: dict[str, Any]
    ) -> TtrpgEncounter:
        """Apply the keys present in ``changes`` (``None`` clears an optional field)."""
        encounter = await self.get(encounter_id, lock=True)
        if encounter.revision != base_revision:
            raise CampaignRevisionError(encounter.revision)
        changed = False

        def assign(name: str, value: Any) -> None:
            nonlocal changed
            if getattr(encounter, name) != value:
                setattr(encounter, name, value)
                changed = True

        if changes.get("title") is not None:
            assign("title", changes["title"])
        for key in ("book_reference", "setup_reminder"):
            if key in changes:
                assign(key, changes[key] or None)
        if "session_id" in changes:
            if changes["session_id"] is not None:
                await self._check_session(encounter.campaign_id, changes["session_id"])
            assign("session_id", changes["session_id"])
        if "location_note_id" in changes:
            if changes["location_note_id"] is not None:
                await self._check_note(changes["location_note_id"])
            assign("location_note_id", changes["location_note_id"])
        if changes.get("party_member_ids") is not None:
            assign(
                "party_member_ids",
                await self._check_party(encounter.campaign_id, changes["party_member_ids"]),
            )
        wants_archived = changes.get("archived")
        if wants_archived is not None and wants_archived != (encounter.archived_at is not None):
            encounter.archived_at = datetime.now(UTC) if wants_archived else None
            changed = True
        if changed:
            encounter.revision += 1
            await self.session.flush()
        return encounter

    # --- slots ---------------------------------------------------------------------

    async def add_slots(
        self, encounter_id: uuid.UUID, spec: SlotSpec, *, base_revision: int
    ) -> list[TtrpgEncounterSlot]:
        encounter = await self.get(encounter_id, lock=True)
        if encounter.revision != base_revision:
            raise CampaignRevisionError(encounter.revision)
        existing = await self._slots(encounter.id)
        if len(existing) + spec.count > MAX_SLOTS:
            raise EncounterValidationError(f"an encounter holds at most {MAX_SLOTS} slots")
        card: TtrpgCreature | None = None
        if spec.creature_id is not None:
            card = await self.session.scalar(
                select(TtrpgCreature).where(
                    TtrpgCreature.id == spec.creature_id, TtrpgCreature.user_id == self.user_id
                )
            )
            if card is None:
                raise CreatureNotFoundError(str(spec.creature_id))
            if card.archived_at is not None:
                raise EncounterValidationError("that creature card is archived")
        elif spec.name is None or spec.ac is None or spec.hp is None:
            raise EncounterValidationError("a custom entry needs a name, AC and HP")

        base_name = spec.name or (card.name if card else "")
        taken = {s.name for s in existing}
        position = max((s.position for s in existing), default=0)
        created: list[TtrpgEncounterSlot] = []
        numbered = spec.count > 1 or any(
            s.creature_id == spec.creature_id and spec.creature_id for s in existing
        )
        for number in range(1, spec.count + 1):
            name = base_name
            if numbered:
                suffix = 1
                while f"{base_name} {suffix}" in taken:
                    suffix += 1
                name = f"{base_name} {suffix}"
            elif name in taken:
                suffix = 2
                while f"{base_name} {suffix}" in taken:
                    suffix += 1
                name = f"{base_name} {suffix}"
            taken.add(name)
            overrides = [
                key
                for key, given in (
                    ("name", spec.name is not None and card is not None),
                    ("ac", spec.ac is not None and card is not None),
                    ("hp", spec.hp is not None and card is not None),
                    ("initiative_mod", spec.initiative_mod is not None and card is not None),
                )
                if given
            ]
            position += 1
            slot = TtrpgEncounterSlot(
                encounter_id=encounter.id,
                user_id=self.user_id,
                position=position,
                side=spec.side,
                creature_id=card.id if card else None,
                name=name[:120],
                ac=spec.ac if spec.ac is not None else (card.ac if card else 0),
                hp=spec.hp if spec.hp is not None else (card.hp if card else 1),
                initiative_mod=(
                    spec.initiative_mod
                    if spec.initiative_mod is not None
                    else (card.initiative_mod if card else 0)
                ),
                overrides=overrides,
                snapshot=snapshot_of(card) if card else {},
            )
            self.session.add(slot)
            created.append(slot)
            del number
        encounter.revision += 1
        await self.session.flush()
        return created

    async def _slot(self, encounter_id: uuid.UUID, slot_id: uuid.UUID) -> TtrpgEncounterSlot:
        slot = await self.session.scalar(
            select(TtrpgEncounterSlot).where(
                TtrpgEncounterSlot.id == slot_id,
                TtrpgEncounterSlot.encounter_id == encounter_id,
                TtrpgEncounterSlot.user_id == self.user_id,
            )
        )
        if slot is None:
            raise SlotNotFoundError(str(slot_id))
        return slot

    async def update_slot(
        self,
        encounter_id: uuid.UUID,
        slot_id: uuid.UUID,
        changes: SlotChanges,
        *,
        base_revision: int,
    ) -> TtrpgEncounterSlot:
        encounter = await self.get(encounter_id, lock=True)
        if encounter.revision != base_revision:
            raise CampaignRevisionError(encounter.revision)
        slot = await self._slot(encounter.id, slot_id)
        overrides = set(slot.overrides)
        changed = False
        for key in OVERRIDABLE:
            value = getattr(changes, key)
            if value is None:
                continue
            if getattr(slot, key) != value:
                setattr(slot, key, value)
                changed = True
            if slot.creature_id is not None:
                overrides.add(key)
        if changes.side is not None and changes.side != slot.side:
            slot.side = changes.side
            changed = True
        if sorted(overrides) != sorted(slot.overrides):
            slot.overrides = sorted(overrides)
            changed = True
        if changed:
            encounter.revision += 1
            await self.session.flush()
        return slot

    async def remove_slot(
        self, encounter_id: uuid.UUID, slot_id: uuid.UUID, *, base_revision: int
    ) -> None:
        encounter = await self.get(encounter_id, lock=True)
        if encounter.revision != base_revision:
            raise CampaignRevisionError(encounter.revision)
        slot = await self._slot(encounter.id, slot_id)
        await self.session.delete(slot)
        encounter.revision += 1
        await self.session.flush()

    async def refresh(
        self, encounter_id: uuid.UUID, *, base_revision: int
    ) -> tuple[TtrpgEncounter, list[SlotRefresh]]:
        """Pull the current card into every slot, **except** fields the DM set by hand.

        A slot whose card is gone or archived is skipped and reported; nothing is guessed.
        """
        encounter = await self.get(encounter_id, lock=True)
        if encounter.revision != base_revision:
            raise CampaignRevisionError(encounter.revision)
        report: list[SlotRefresh] = []
        any_changed = False
        for slot in await self._slots(encounter.id):
            if slot.creature_id is None:
                report.append(SlotRefresh(slot.id, slot.name, "no_card"))
                continue
            card = await self.session.get(TtrpgCreature, slot.creature_id)
            if card is None or card.user_id != self.user_id:
                report.append(SlotRefresh(slot.id, slot.name, "no_card"))
                continue
            if card.archived_at is not None:
                report.append(SlotRefresh(slot.id, slot.name, "card_archived"))
                continue
            fresh = {"ac": card.ac, "hp": card.hp, "initiative_mod": card.initiative_mod}
            snapshot = snapshot_of(card)
            changed = snapshot != slot.snapshot
            for key, value in fresh.items():
                if key not in slot.overrides and getattr(slot, key) != value:
                    setattr(slot, key, value)
                    changed = True
            if changed:
                slot.snapshot = snapshot
                any_changed = True
            report.append(SlotRefresh(slot.id, slot.name, "refreshed" if changed else "unchanged"))
        if any_changed:
            encounter.revision += 1
        await self.session.flush()
        return encounter, report

    # --- note launch link ---------------------------------------------------------------

    async def link_into_session_note(self, encounter_id: uuid.UUID) -> tuple[str, bool]:
        """Add this encounter's launch link under the session note's "Prep" heading.

        Returns ``(markdown link, changed)``. Idempotent (a note that already has the link is not
        touched) and revision-checked against the note, so a concurrent edit is a conflict.
        """
        encounter = await self.get(encounter_id)
        link = link_markdown(encounter.id, encounter.title)
        if encounter.session_id is None:
            raise EncounterValidationError("attach the encounter to a session first")
        session_row = await self.session.get(TtrpgSession, encounter.session_id)
        if session_row is None or session_row.note_id is None:
            raise EncounterValidationError("the session has no note")
        try:
            note = await self.notes.get(session_row.note_id)
        except NoteNotFoundError as exc:
            raise EncounterValidationError("the session note is missing: repair it first") from exc
        content = self.storage.read(note.path).content
        if f"{ENCOUNTER_PATH}/{encounter.id}" in content:
            return link, False
        await self.notes.update(
            note.id, insert_under_prep(content, f"- Encounter: {link}"), note.revision
        )
        return link, True


def insert_under_prep(content: str, bullet: str) -> str:
    """Put ``bullet`` at the end of the "Prep" section (or add the section)."""
    newline = "\r\n" if "\r\n" in content else "\n"
    lines = content.split(newline)
    in_fence = False
    start: int | None = None
    level = 2
    for index, line in enumerate(lines):
        if line.lstrip().startswith(("```", "~~~")):
            in_fence = not in_fence
        match = None if in_fence else re.match(r"^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$", line)
        if match and start is None and match.group(2).strip().casefold() == "prep":
            start, level = index, len(match.group(1))
        elif match and start is not None and len(match.group(1)) <= level:
            end = index
            break
    else:
        end = len(lines)
    if start is None:
        body = content.rstrip("\r\n")
        return f"{body}{newline}{newline}## Prep{newline}{newline}{bullet}{newline}"
    section = lines[start + 1 : end]
    while section and section[-1].strip() == "":
        section.pop()
    if not section or section[0].strip() != "":
        section.insert(0, "")
    section.append(bullet)
    tail = lines[end:]
    rebuilt = lines[: start + 1] + section + ([""] if tail else []) + tail
    return newline.join(rebuilt)
