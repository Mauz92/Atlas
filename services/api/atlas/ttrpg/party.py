"""Party cards and persistent play state (TTRPG-03).

A *card* is the reusable description of a character; the *play state* is what changes between and
during fights and is the single copy that combat will read and write. Each has its own revision and
both are revision-checked: a stale client gets a conflict and nothing is overwritten. Retired
members are archived, never deleted, so historical runs still resolve them.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)
from sqlalchemy import case, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import TtrpgCampaign, TtrpgPartyMember, TtrpgPartyState
from . import rules
from .campaigns import CampaignIdTakenError, CampaignNotFoundError, CampaignRevisionError

ShortText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
LongText = Annotated[str, StringConstraints(strip_whitespace=True, max_length=2000)]
_KEY = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")


class PartyNotFoundError(LookupError):
    pass


class PartyValidationError(ValueError):
    pass


class Attack(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: ShortText
    to_hit: int | None = Field(default=None, ge=-20, le=40)
    damage: Annotated[str, StringConstraints(strip_whitespace=True, max_length=120)] = ""
    notes: LongText = ""


class Ability(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: ShortText
    text: LongText = ""


class Resource(BaseModel):
    model_config = ConfigDict(extra="forbid")

    key: str
    name: ShortText
    max: int = Field(ge=1, le=99)
    reset: Literal["short", "long", "none"] = "long"

    @field_validator("key")
    @classmethod
    def _key(cls, value: str) -> str:
        if not _KEY.match(value):
            raise ValueError("key must be 1-32 characters of a-z, 0-9, '-' or '_'")
        return value


class CardFields(BaseModel):
    """The editable description of a party member."""

    model_config = ConfigDict(extra="forbid")

    role: Literal["pc", "companion"] = "pc"
    name: ShortText
    level: int | None = Field(default=None, ge=1, le=20)
    ac: int = Field(ge=0, le=40)
    max_hp: int = Field(ge=1, le=9999)
    speed: int | None = Field(default=None, ge=0, le=500)
    initiative_mod: int = Field(default=0, ge=-10, le=30)
    passive_perception: int | None = Field(default=None, ge=0, le=40)
    attacks: list[Attack] = Field(default_factory=list, max_length=20)
    abilities: list[Ability] = Field(default_factory=list, max_length=30)
    resources: list[Resource] = Field(default_factory=list, max_length=20)

    @model_validator(mode="after")
    def _unique_keys(self) -> CardFields:
        keys = [resource.key for resource in self.resources]
        if len(keys) != len(set(keys)):
            raise ValueError("resource keys must be unique")
        return self


class StateFields(BaseModel):
    """Direct corrections of play state; every field is optional."""

    model_config = ConfigDict(extra="forbid")

    current_hp: int | None = Field(default=None, ge=0, le=9999)
    temp_hp: int | None = Field(default=None, ge=0, le=9999)
    conditions: list[str] | None = Field(default=None, max_length=len(rules.CONDITIONS))
    exhaustion_level: int | None = Field(default=None, ge=0, le=rules.MAX_EXHAUSTION)
    death_save_successes: int | None = Field(default=None, ge=0, le=rules.DEATH_SAVE_LIMIT)
    death_save_failures: int | None = Field(default=None, ge=0, le=rules.DEATH_SAVE_LIMIT)
    resources_used: dict[str, int] | None = None


@dataclass(frozen=True)
class MemberView:
    member: TtrpgPartyMember
    state: TtrpgPartyState


def _resource_defs(member: TtrpgPartyMember) -> list[rules.ResourceDef]:
    return [rules.ResourceDef(item["key"], item["max"], item["reset"]) for item in member.resources]


def normalize_state(member: TtrpgPartyMember, state: TtrpgPartyState) -> None:
    """Make a state consistent with its card (clamps, no stray resource keys, no stale saves)."""
    state.current_hp = max(0, min(state.current_hp, member.max_hp))
    state.temp_hp = max(0, state.temp_hp)
    known = {item["key"]: item["max"] for item in member.resources}
    state.resources_used = {
        key: max(0, min(int(value), known[key]))
        for key, value in state.resources_used.items()
        if key in known and int(value) > 0
    }
    if state.current_hp > 0:
        state.death_save_successes = 0
        state.death_save_failures = 0
    state.conditions = sorted({c for c in state.conditions if c in rules.CONDITIONS})


class PartyService:
    def __init__(self, session: AsyncSession, user_id: uuid.UUID) -> None:
        self.session = session
        self.user_id = user_id

    async def _campaign(self, campaign_id: uuid.UUID, *, lock: bool = False) -> TtrpgCampaign:
        stmt = select(TtrpgCampaign).where(
            TtrpgCampaign.id == campaign_id, TtrpgCampaign.user_id == self.user_id
        )
        if lock:
            stmt = stmt.with_for_update().execution_options(populate_existing=True)
        campaign = await self.session.scalar(stmt)
        if campaign is None:
            raise CampaignNotFoundError(str(campaign_id))
        return campaign

    async def _member(self, member_id: uuid.UUID, *, lock: bool = False) -> TtrpgPartyMember:
        stmt = select(TtrpgPartyMember).where(
            TtrpgPartyMember.id == member_id, TtrpgPartyMember.user_id == self.user_id
        )
        if lock:
            stmt = stmt.with_for_update().execution_options(populate_existing=True)
        member = await self.session.scalar(stmt)
        if member is None:
            raise PartyNotFoundError(str(member_id))
        return member

    async def _state(self, member_id: uuid.UUID, *, lock: bool = False) -> TtrpgPartyState:
        stmt = select(TtrpgPartyState).where(
            TtrpgPartyState.member_id == member_id, TtrpgPartyState.user_id == self.user_id
        )
        if lock:
            stmt = stmt.with_for_update().execution_options(populate_existing=True)
        state = await self.session.scalar(stmt)
        if state is None:  # cannot happen through this service; repaired rather than failing
            member = await self._member(member_id)
            state = TtrpgPartyState(
                member_id=member.id, user_id=self.user_id, current_hp=member.max_hp
            )
            self.session.add(state)
            await self.session.flush()
        return state

    # --- queries -----------------------------------------------------------

    async def list_members(
        self, campaign_id: uuid.UUID, *, include_archived: bool = False
    ) -> list[MemberView]:
        await self._campaign(campaign_id)
        stmt = (
            select(TtrpgPartyMember, TtrpgPartyState)
            .join(TtrpgPartyState, TtrpgPartyState.member_id == TtrpgPartyMember.id)
            .where(
                TtrpgPartyMember.campaign_id == campaign_id,
                TtrpgPartyMember.user_id == self.user_id,
            )
            .order_by(
                case((TtrpgPartyMember.role == "pc", 0), else_=1),
                TtrpgPartyMember.created_at,
                TtrpgPartyMember.id,
            )
        )
        if not include_archived:
            stmt = stmt.where(TtrpgPartyMember.archived_at.is_(None))
        return [MemberView(m, s) for m, s in (await self.session.execute(stmt)).all()]

    async def get(self, member_id: uuid.UUID) -> MemberView:
        member = await self._member(member_id)
        return MemberView(member, await self._state(member.id))

    # --- cards -------------------------------------------------------------

    async def add_member(
        self, campaign_id: uuid.UUID, card: CardFields, *, member_id: uuid.UUID | None = None
    ) -> tuple[MemberView, bool]:
        campaign = await self._campaign(campaign_id, lock=True)
        if member_id is not None:
            existing = await self.session.get(TtrpgPartyMember, member_id)
            if existing is not None:
                if existing.user_id != self.user_id or existing.campaign_id != campaign.id:
                    raise CampaignIdTakenError(str(member_id))
                return await self.get(existing.id), False
        if campaign.archived_at is not None:
            raise PartyValidationError("an archived campaign cannot get new party members")
        member = TtrpgPartyMember(
            id=member_id or uuid.uuid4(),
            campaign_id=campaign.id,
            user_id=self.user_id,
            **self._card_columns(card),
        )
        self.session.add(member)
        try:
            await self.session.flush()
        except IntegrityError as exc:
            raise CampaignIdTakenError(str(member_id)) from exc
        state = TtrpgPartyState(member_id=member.id, user_id=self.user_id, current_hp=member.max_hp)
        self.session.add(state)
        await self.session.flush()
        return MemberView(member, state), True

    @staticmethod
    def _card_columns(card: CardFields) -> dict[str, Any]:
        return {
            "role": card.role,
            "name": card.name,
            "level": card.level,
            "ac": card.ac,
            "max_hp": card.max_hp,
            "speed": card.speed,
            "initiative_mod": card.initiative_mod,
            "passive_perception": card.passive_perception,
            "attacks": [a.model_dump() for a in card.attacks],
            "abilities": [a.model_dump() for a in card.abilities],
            "resources": [r.model_dump() for r in card.resources],
        }

    async def update_card(
        self, member_id: uuid.UUID, card: CardFields, *, base_revision: int
    ) -> MemberView:
        member = await self._member(member_id, lock=True)
        if member.revision != base_revision:
            raise CampaignRevisionError(member.revision)
        state = await self._state(member.id, lock=True)
        columns = self._card_columns(card)
        changed = any(getattr(member, name) != value for name, value in columns.items())
        if not changed:
            return MemberView(member, state)
        for name, value in columns.items():
            setattr(member, name, value)
        member.revision += 1
        before = (state.current_hp, dict(state.resources_used), state.death_save_failures)
        normalize_state(member, state)
        if before != (state.current_hp, dict(state.resources_used), state.death_save_failures):
            state.revision += 1
        await self.session.flush()
        return MemberView(member, state)

    async def set_archived(
        self, member_id: uuid.UUID, archived: bool, *, base_revision: int
    ) -> MemberView:
        member = await self._member(member_id, lock=True)
        if member.revision != base_revision:
            raise CampaignRevisionError(member.revision)
        if archived != (member.archived_at is not None):
            member.archived_at = datetime.now(UTC) if archived else None
            member.revision += 1
            await self.session.flush()
        return MemberView(member, await self._state(member.id))

    # --- play state --------------------------------------------------------

    async def update_state(
        self, member_id: uuid.UUID, changes: StateFields, *, base_revision: int
    ) -> MemberView:
        """Direct correction of play state (revision-checked, partial)."""
        member = await self._member(member_id)
        state = await self._state(member_id, lock=True)
        if state.revision != base_revision:
            raise CampaignRevisionError(state.revision)
        if changes.current_hp is not None:
            if changes.current_hp > member.max_hp:
                raise PartyValidationError("current hit points cannot exceed the maximum")
            state.current_hp = changes.current_hp
        if changes.temp_hp is not None:
            state.temp_hp = changes.temp_hp
        if changes.conditions is not None:
            unknown = sorted(set(changes.conditions) - set(rules.CONDITIONS))
            if unknown:
                raise PartyValidationError(f"unknown condition: {', '.join(unknown)}")
            state.conditions = sorted(set(changes.conditions))
        if changes.exhaustion_level is not None:
            state.exhaustion_level = changes.exhaustion_level
        if changes.death_save_successes is not None:
            state.death_save_successes = changes.death_save_successes
        if changes.death_save_failures is not None:
            state.death_save_failures = changes.death_save_failures
        if changes.resources_used is not None:
            known = {item["key"]: item["max"] for item in member.resources}
            for key, value in changes.resources_used.items():
                if key not in known:
                    raise PartyValidationError(f"unknown resource: {key}")
                if not 0 <= value <= known[key]:
                    raise PartyValidationError(f"{key} must be between 0 and {known[key]}")
            state.resources_used = {k: v for k, v in changes.resources_used.items() if v > 0}
        if state.current_hp > 0 and (changes.death_save_successes or changes.death_save_failures):
            raise PartyValidationError("death saves only apply at 0 hit points")
        normalize_state(member, state)
        state.revision += 1
        await self.session.flush()
        return MemberView(member, state)

    async def adjust_hp(
        self,
        member_id: uuid.UUID,
        kind: Literal["damage", "heal", "temp_hp"],
        amount: int,
        *,
        base_revision: int,
    ) -> MemberView:
        member = await self._member(member_id)
        state = await self._state(member_id, lock=True)
        if state.revision != base_revision:
            raise CampaignRevisionError(state.revision)
        if kind == "damage":
            state.current_hp, state.temp_hp = rules.apply_damage(
                state.current_hp, state.temp_hp, amount
            )
        elif kind == "heal":
            state.current_hp = rules.apply_healing(state.current_hp, member.max_hp, amount)
        else:
            state.temp_hp = rules.grant_temp_hp(state.temp_hp, amount)
        normalize_state(member, state)
        state.revision += 1
        await self.session.flush()
        return MemberView(member, state)

    # --- rests -------------------------------------------------------------

    async def preview_rest(
        self, campaign_id: uuid.UUID, kind: rules.RestKind
    ) -> list[tuple[MemberView, rules.RestChange]]:
        views = await self.list_members(campaign_id)
        return [(view, self._preview(kind, view)) for view in views]

    @staticmethod
    def _preview(kind: rules.RestKind, view: MemberView) -> rules.RestChange:
        member, state = view.member, view.state
        return rules.preview_rest(
            kind,
            max_hp=member.max_hp,
            hp=state.current_hp,
            temp_hp=state.temp_hp,
            exhaustion_level=state.exhaustion_level,
            death_save_successes=state.death_save_successes,
            death_save_failures=state.death_save_failures,
            resources=_resource_defs(member),
            resources_used=state.resources_used,
        )

    async def apply_rest(
        self,
        campaign_id: uuid.UUID,
        kind: rules.RestKind,
        confirmations: list[tuple[uuid.UUID, int, StateFields | None]],
    ) -> list[MemberView]:
        """Apply the previewed rest to the confirmed members, all or none.

        Each confirmation names a member and the state revision the DM saw; ``overrides`` replace
        the proposal field by field. A member whose state changed meanwhile fails the whole rest
        with a conflict and nothing is changed.
        """
        await self._campaign(campaign_id, lock=True)
        done: list[MemberView] = []
        seen: set[uuid.UUID] = set()
        for member_id, base_revision, overrides in confirmations:
            if member_id in seen:
                raise PartyValidationError("a member can be confirmed only once")
            seen.add(member_id)
            member = await self._member(member_id)
            if member.campaign_id != campaign_id:
                raise PartyNotFoundError(str(member_id))
            state = await self._state(member_id, lock=True)
            if state.revision != base_revision:
                raise CampaignRevisionError(state.revision)
            change = self._preview(kind, MemberView(member, state))
            if change.hp:
                state.current_hp = change.hp[1]
            if change.temp_hp:
                state.temp_hp = change.temp_hp[1]
            if change.exhaustion_level:
                state.exhaustion_level = change.exhaustion_level[1]
            if change.death_saves_cleared:
                state.death_save_successes = 0
                state.death_save_failures = 0
            if change.resources_used:
                used = dict(state.resources_used)
                for key in change.resources_used:
                    used.pop(key, None)
                state.resources_used = used
            if overrides is not None:
                if overrides.current_hp is not None:
                    if overrides.current_hp > member.max_hp:
                        raise PartyValidationError("current hit points cannot exceed the maximum")
                    state.current_hp = overrides.current_hp
                if overrides.temp_hp is not None:
                    state.temp_hp = overrides.temp_hp
                if overrides.exhaustion_level is not None:
                    state.exhaustion_level = overrides.exhaustion_level
                if overrides.resources_used is not None:
                    known = {item["key"]: item["max"] for item in member.resources}
                    for key, value in overrides.resources_used.items():
                        if key not in known or not 0 <= value <= known[key]:
                            raise PartyValidationError(f"invalid resource override: {key}")
                    state.resources_used = {
                        k: v for k, v in overrides.resources_used.items() if v > 0
                    }
            normalize_state(member, state)
            state.revision += 1
            done.append(MemberView(member, state))
        await self.session.flush()
        return done
