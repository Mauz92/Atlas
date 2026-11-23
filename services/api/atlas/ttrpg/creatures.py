"""Creature cards: manual entry, SRD import with provenance, variants and explicit refresh.

Rules this module keeps (TTRPG-04):

* A manual card needs only a name, AC and HP; everything else is optional.
* An imported card is a read-only snapshot with its source edition, external id and attribution. A
  repeated import returns the existing card (idempotent), and an upstream change reaches a card only
  through :meth:`CreatureService.refresh`, never silently.
* Editing an imported card is done on a *variant* (a manual copy that keeps the attribution).
* Cards are archived, never deleted, so encounters and runs that snapshotted them still resolve.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import TtrpgCreature
from .campaigns import CampaignIdTakenError, CampaignRevisionError
from .srd import ATTRIBUTION, EDITION, SrdCatalog, SrdMonster

ShortText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
LongText = Annotated[str, StringConstraints(strip_whitespace=True, max_length=4000)]
OptionalShort = Annotated[str, StringConstraints(strip_whitespace=True, max_length=120)]


class CreatureNotFoundError(LookupError):
    pass


class CreatureValidationError(ValueError):
    pass


class Trait(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: ShortText
    text: LongText = ""


class CreatureAction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: ShortText
    text: LongText = ""
    kind: Literal["action", "reaction", "legendary"] = "action"
    to_hit: int | None = Field(default=None, ge=-20, le=40)
    damage: Annotated[str, StringConstraints(strip_whitespace=True, max_length=200)] = ""


class CreatureFields(BaseModel):
    """The editable description of a creature (name, AC and HP are the minimum)."""

    model_config = ConfigDict(extra="forbid")

    name: ShortText
    ac: int = Field(ge=0, le=40)
    hp: int = Field(ge=1, le=9999)
    speed: Annotated[str, StringConstraints(strip_whitespace=True, max_length=200)] | None = None
    initiative_mod: int = Field(default=0, ge=-10, le=30)
    challenge_rating: Annotated[str, StringConstraints(max_length=8)] | None = None
    size: Annotated[str, StringConstraints(strip_whitespace=True, max_length=32)] | None = None
    creature_type: OptionalShort | None = None
    traits: list[Trait] = Field(default_factory=list, max_length=30)
    actions: list[CreatureAction] = Field(default_factory=list, max_length=60)


def _columns(card: CreatureFields) -> dict[str, Any]:
    return {
        "name": card.name,
        "ac": card.ac,
        "hp": card.hp,
        "speed": card.speed or None,
        "initiative_mod": card.initiative_mod,
        "challenge_rating": card.challenge_rating or None,
        "size": card.size or None,
        "creature_type": card.creature_type or None,
        "traits": [t.model_dump() for t in card.traits],
        "actions": [a.model_dump() for a in card.actions],
    }


def _monster_columns(monster: SrdMonster) -> dict[str, Any]:
    return {
        "name": monster.name,
        "ac": monster.ac,
        "hp": monster.hp,
        "speed": monster.speed,
        "initiative_mod": monster.initiative_mod,
        "challenge_rating": monster.challenge_rating,
        "size": monster.size,
        "creature_type": monster.creature_type,
        "traits": [{"name": t.name, "text": t.text} for t in monster.traits],
        "actions": [
            {
                "name": a.name,
                "text": a.text,
                "kind": a.kind,
                "to_hit": a.to_hit,
                "damage": a.damage,
            }
            for a in monster.actions
        ],
    }


class CreatureService:
    def __init__(self, session: AsyncSession, user_id: uuid.UUID) -> None:
        self.session = session
        self.user_id = user_id

    async def get(self, creature_id: uuid.UUID, *, lock: bool = False) -> TtrpgCreature:
        stmt = select(TtrpgCreature).where(
            TtrpgCreature.id == creature_id, TtrpgCreature.user_id == self.user_id
        )
        if lock:
            stmt = stmt.with_for_update().execution_options(populate_existing=True)
        card = await self.session.scalar(stmt)
        if card is None:
            raise CreatureNotFoundError(str(creature_id))
        return card

    async def list_cards(
        self, *, query: str = "", include_archived: bool = False, limit: int = 200
    ) -> list[TtrpgCreature]:
        stmt = select(TtrpgCreature).where(TtrpgCreature.user_id == self.user_id)
        if not include_archived:
            stmt = stmt.where(TtrpgCreature.archived_at.is_(None))
        if query.strip():
            escaped = query.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            stmt = stmt.where(TtrpgCreature.name.ilike(f"%{escaped}%", escape="\\"))
        rows = await self.session.scalars(
            stmt.order_by(TtrpgCreature.name, TtrpgCreature.id).limit(limit)
        )
        return list(rows)

    async def create(
        self, card: CreatureFields, *, creature_id: uuid.UUID | None = None
    ) -> tuple[TtrpgCreature, bool]:
        if creature_id is not None:
            existing = await self.session.get(TtrpgCreature, creature_id)
            if existing is not None:
                if existing.user_id != self.user_id:
                    raise CampaignIdTakenError(str(creature_id))
                return existing, False
        row = TtrpgCreature(
            id=creature_id or uuid.uuid4(), user_id=self.user_id, source="manual", **_columns(card)
        )
        self.session.add(row)
        try:
            await self.session.flush()
        except IntegrityError as exc:
            raise CampaignIdTakenError(str(creature_id)) from exc
        return row, True

    async def update(
        self, creature_id: uuid.UUID, card: CreatureFields, *, base_revision: int
    ) -> TtrpgCreature:
        row = await self.get(creature_id, lock=True)
        if row.source != "manual":
            raise CreatureValidationError(
                "an imported card is read-only: duplicate it to make an editable variant"
            )
        if row.revision != base_revision:
            raise CampaignRevisionError(row.revision)
        columns = _columns(card)
        if any(getattr(row, k) != v for k, v in columns.items()):
            for key, value in columns.items():
                setattr(row, key, value)
            row.revision += 1
            await self.session.flush()
        return row

    async def duplicate(
        self, creature_id: uuid.UUID, *, new_id: uuid.UUID | None = None
    ) -> tuple[TtrpgCreature, bool]:
        """An editable manual copy; an SRD source keeps its attribution on the variant."""
        if new_id is not None:
            existing = await self.session.get(TtrpgCreature, new_id)
            if existing is not None:
                if existing.user_id != self.user_id or existing.derived_from_id != creature_id:
                    raise CampaignIdTakenError(str(new_id))
                return existing, False
        source = await self.get(creature_id)
        columns = {
            "name": source.name,
            "ac": source.ac,
            "hp": source.hp,
            "speed": source.speed,
            "initiative_mod": source.initiative_mod,
            "challenge_rating": source.challenge_rating,
            "size": source.size,
            "creature_type": source.creature_type,
            "traits": list(source.traits),
            "actions": list(source.actions),
        }
        row = TtrpgCreature(
            id=new_id or uuid.uuid4(),
            user_id=self.user_id,
            source="manual",
            derived_from_id=source.id,
            attribution=source.attribution,
            **columns,
        )
        row.name = f"{source.name} (variant)"[:120]
        self.session.add(row)
        await self.session.flush()
        return row, True

    async def set_archived(
        self, creature_id: uuid.UUID, archived: bool, *, base_revision: int
    ) -> TtrpgCreature:
        row = await self.get(creature_id, lock=True)
        if row.revision != base_revision:
            raise CampaignRevisionError(row.revision)
        if archived != (row.archived_at is not None):
            row.archived_at = datetime.now(UTC) if archived else None
            row.revision += 1
            await self.session.flush()
        return row

    # --- SRD ----------------------------------------------------------------

    async def imported_ids(self, indexes: list[str]) -> dict[str, uuid.UUID]:
        if not indexes:
            return {}
        rows = await self.session.execute(
            select(TtrpgCreature.external_id, TtrpgCreature.id).where(
                TtrpgCreature.user_id == self.user_id,
                TtrpgCreature.source == "srd",
                TtrpgCreature.source_edition == EDITION,
                TtrpgCreature.external_id.in_(indexes),
            )
        )
        return {external: card_id for external, card_id in rows if external is not None}

    async def import_srd(self, catalog: SrdCatalog, index: str) -> tuple[TtrpgCreature, bool]:
        """Import one SRD creature. A second import of the same creature returns the first card
        without calling the catalogue again."""
        existing = (await self.imported_ids([index])).get(index)
        if existing is not None:
            return await self.get(existing), False
        monster = await catalog.fetch(index)
        row = TtrpgCreature(
            id=uuid.uuid4(),
            user_id=self.user_id,
            source="srd",
            source_edition=EDITION,
            external_id=monster.index,
            attribution=ATTRIBUTION,
            imported_at=datetime.now(UTC),
            **_monster_columns(monster),
        )
        self.session.add(row)
        try:
            await self.session.flush()
        except IntegrityError:
            # a concurrent import of the same creature won the unique index
            await self.session.rollback()
            winner = (await self.imported_ids([index])).get(index)
            if winner is None:
                raise
            return await self.get(winner), False
        return row, True

    async def refresh(
        self, catalog: SrdCatalog, creature_id: uuid.UUID, *, base_revision: int
    ) -> TtrpgCreature:
        """Re-fetch an imported card and replace its snapshot (explicit; bumps the revision only
        when something actually changed)."""
        row = await self.get(creature_id, lock=True)
        if row.source != "srd" or row.external_id is None:
            raise CreatureValidationError("only an imported card can be refreshed")
        if row.revision != base_revision:
            raise CampaignRevisionError(row.revision)
        monster = await catalog.fetch(row.external_id)
        columns = _monster_columns(monster)
        changed = any(getattr(row, k) != v for k, v in columns.items())
        if changed:
            for key, value in columns.items():
                setattr(row, key, value)
            row.revision += 1
        row.imported_at = datetime.now(UTC)
        await self.session.flush()
        return row
