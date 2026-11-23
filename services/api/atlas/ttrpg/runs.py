"""Combat runs: setup, initiative, turns, actions, undo, pause/resume and end (TTRPG-06).

How a change is made (``RunService.apply``), in one transaction:

1. lock the run row; a request whose ``mutation_key`` was already applied is a **replay** (same
   request: the stored result, nothing re-applied; different request: refused);
2. check the status allows the action and that the client's run ``revision`` is current;
3. apply the action, recording exactly the fields it changed (``before``/``after``) for the run,
   the combatants and the **party play state** it touched. A party slot has no hit points of its
   own: the party member's state is the single copy, locked and revision-checked here too;
4. bump the run revision (and the revision of every party state touched), append the action to the
   history and flush. The caller commits, so the run, the party state and the history are
   all-or-nothing.

Undo reverts the most recent reversible, not-yet-undone action from its stored ``before`` values,
but only when nothing else changed the affected state since (the combatant fields still equal the
recorded ``after`` and the party state still has the recorded revision). Otherwise the undo is a
conflict, nothing changes, and the newer state stays.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import (
    TtrpgCampaign,
    TtrpgCombatAction,
    TtrpgCombatant,
    TtrpgCombatRun,
    TtrpgCreature,
    TtrpgEncounter,
    TtrpgEncounterSlot,
    TtrpgPartyMember,
    TtrpgPartyState,
    TtrpgSession,
)
from . import rules
from .campaigns import CampaignIdTakenError, CampaignNotFoundError, CampaignRevisionError
from .combat import Seat, advance, initial_order, insertion_index, tie_groups
from .creatures import CreatureNotFoundError
from .encounters import EncounterNotFoundError, snapshot_of
from .party import normalize_state

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
UNFINISHED = ("setup", "active", "paused")
HISTORY_LIMIT = 50


class RunNotFoundError(LookupError):
    pass


class RunValidationError(ValueError):
    pass


class RunExistsError(RuntimeError):
    """The campaign already has an unfinished run."""

    def __init__(self, run_id: uuid.UUID) -> None:
        super().__init__("this campaign already has an unfinished fight")
        self.run_id = run_id


class PartyRevisionError(RuntimeError):
    def __init__(self, member_id: uuid.UUID, name: str, current: int) -> None:
        super().__init__(f"{name} changed since it was read")
        self.member_id = member_id
        self.current_revision = current


class MutationKeyReusedError(RuntimeError):
    pass


class UndoConflictError(RuntimeError):
    """Something else changed the affected state after the action: the undo would lose it."""


class NothingToUndoError(RuntimeError):
    pass


# --- requests ---


class NewCombatant(BaseModel):
    """A reinforcement or an improvised combatant."""

    model_config = ConfigDict(extra="forbid")

    creature_id: uuid.UUID | None = None
    name: Name | None = None
    ac: int | None = Field(default=None, ge=0, le=40)
    hp: int | None = Field(default=None, ge=1, le=9999)
    initiative_mod: int | None = Field(default=None, ge=-10, le=30)
    side: Literal["enemy", "ally"] = "enemy"
    initiative: int | None = Field(default=None, ge=-100, le=100)


ActionKind = Literal[
    "damage",
    "heal",
    "temp_hp",
    "set_hp",
    "add_condition",
    "remove_condition",
    "death_save",
    "spend_resource",
    "next_turn",
    "set_defeated",
    "remove_combatant",
    "restore_combatant",
    "add_combatant",
    "reorder",
    "pause",
    "resume",
    "end",
]


class ActionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: ActionKind
    combatant_id: uuid.UUID | None = None
    amount: int | None = Field(default=None, ge=0, le=9999)
    hp: int | None = Field(default=None, ge=0, le=9999)
    condition: str | None = Field(default=None, max_length=32)
    expires_round: int | None = Field(default=None, ge=1, le=999)
    death_save: Literal["success", "failure", "reset"] | None = None
    resource_key: str | None = Field(default=None, max_length=32)
    delta: Literal[-1, 1] | None = None
    defeated: bool | None = None
    order: list[uuid.UUID] | None = Field(default=None, max_length=100)
    new_combatant: NewCombatant | None = None
    outcome: str | None = Field(default=None, max_length=2000)
    #: expected play-state revision of each party member this action touches
    party_revisions: dict[uuid.UUID, int] = Field(default_factory=dict)


class SetupNpc(NewCombatant):
    pass


# --- views ---


@dataclass(frozen=True)
class CombatantView:
    row: TtrpgCombatant
    member: TtrpgPartyMember | None
    state: TtrpgPartyState | None

    @property
    def hp(self) -> int:
        return self.state.current_hp if self.state else (self.row.hp or 0)

    @property
    def temp_hp(self) -> int:
        return self.state.temp_hp if self.state else (self.row.temp_hp or 0)

    @property
    def conditions(self) -> list[str]:
        return list(self.state.conditions) if self.state else list(self.row.conditions)


@dataclass(frozen=True)
class RunView:
    run: TtrpgCombatRun
    combatants: list[CombatantView]
    ties: list[list[uuid.UUID]]
    undo: TtrpgCombatAction | None
    history: list[TtrpgCombatAction]
    reminders_due: list[tuple[uuid.UUID, str, int]] = field(default_factory=list)


@dataclass(frozen=True)
class ApplyResult:
    view: RunView
    action: TtrpgCombatAction | None
    replayed: bool


def _fingerprint(request: ActionRequest) -> str:
    payload = request.model_dump(mode="json", exclude_none=True, exclude={"party_revisions"})
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


def _json(value: Any) -> Any:
    """A JSON-safe form of a recorded value (ids as strings, times as ISO text)."""
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    return value


class Tracker:
    """Records the before/after of every field an action changes."""

    def __init__(self) -> None:
        self.before: dict[str, Any] = {"run": {}, "combatants": {}, "party": {}}
        self.after: dict[str, Any] = {"run": {}, "combatants": {}, "party": {}}
        self.party_touched: dict[uuid.UUID, TtrpgPartyState] = {}

    def _put(self, bucket: str, key: str | None, name: str, old: Any, new: Any) -> None:
        if bucket == "run":
            before, after = self.before["run"], self.after["run"]
        else:
            before = self.before[bucket].setdefault(key, {})
            after = self.after[bucket].setdefault(key, {})
        before.setdefault(name, old)
        after[name] = new

    def run(self, run: TtrpgCombatRun, name: str, value: Any) -> None:
        self._put("run", None, name, _json(getattr(run, name)), _json(value))
        setattr(run, name, value)

    def combatant(self, row: TtrpgCombatant, name: str, value: Any) -> None:
        old = getattr(row, name)
        if isinstance(old, dict):
            old = dict(old)
        elif isinstance(old, list):
            old = list(old)
        self._put("combatants", str(row.id), name, old, value)
        setattr(row, name, value)

    def party(self, state: TtrpgPartyState, name: str, value: Any) -> None:
        key = str(state.member_id)
        if state.member_id not in self.party_touched:
            self.party_touched[state.member_id] = state
            self.before["party"].setdefault(key, {})["_revision"] = state.revision
        old = getattr(state, name)
        if isinstance(old, dict):
            old = dict(old)
        elif isinstance(old, list):
            old = list(old)
        self._put("party", key, name, old, value)
        setattr(state, name, value)

    def finish(self) -> None:
        """Bump every touched party state's revision and record it (once per action)."""
        for member_id, state in self.party_touched.items():
            state.revision += 1
            self.after["party"].setdefault(str(member_id), {})["_revision"] = state.revision


class RunService:
    def __init__(self, session: AsyncSession, user_id: uuid.UUID) -> None:
        self.session = session
        self.user_id = user_id

    # --- loading ---

    async def _run(self, run_id: uuid.UUID, *, lock: bool = False) -> TtrpgCombatRun:
        stmt = select(TtrpgCombatRun).where(
            TtrpgCombatRun.id == run_id, TtrpgCombatRun.user_id == self.user_id
        )
        if lock:
            stmt = stmt.with_for_update().execution_options(populate_existing=True)
        run = await self.session.scalar(stmt)
        if run is None:
            raise RunNotFoundError(str(run_id))
        return run

    async def _rows(self, run_id: uuid.UUID, *, lock: bool = False) -> list[TtrpgCombatant]:
        stmt = select(TtrpgCombatant).where(
            TtrpgCombatant.run_id == run_id, TtrpgCombatant.user_id == self.user_id
        )
        if lock:
            stmt = stmt.with_for_update().execution_options(populate_existing=True)
        return list(await self.session.scalars(stmt.order_by(TtrpgCombatant.position)))

    async def _party(
        self, member_ids: list[uuid.UUID], *, lock: bool = False
    ) -> dict[uuid.UUID, tuple[TtrpgPartyMember, TtrpgPartyState]]:
        if not member_ids:
            return {}
        stmt = (
            select(TtrpgPartyMember, TtrpgPartyState)
            .join(TtrpgPartyState, TtrpgPartyState.member_id == TtrpgPartyMember.id)
            .where(TtrpgPartyMember.id.in_(member_ids), TtrpgPartyMember.user_id == self.user_id)
        )
        if lock:
            stmt = stmt.with_for_update(of=TtrpgPartyState).execution_options(
                populate_existing=True
            )
        return {m.id: (m, s) for m, s in (await self.session.execute(stmt)).all()}

    async def _actions(
        self, run_id: uuid.UUID, *, limit: int = HISTORY_LIMIT, before_seq: int | None = None
    ) -> list[TtrpgCombatAction]:
        stmt = select(TtrpgCombatAction).where(
            TtrpgCombatAction.run_id == run_id, TtrpgCombatAction.user_id == self.user_id
        )
        if before_seq is not None:
            stmt = stmt.where(TtrpgCombatAction.seq < before_seq)
        rows = await self.session.scalars(stmt.order_by(TtrpgCombatAction.seq.desc()).limit(limit))
        return list(rows)

    async def _undo_target(self, run_id: uuid.UUID) -> TtrpgCombatAction | None:
        target: TtrpgCombatAction | None = await self.session.scalar(
            select(TtrpgCombatAction)
            .where(
                TtrpgCombatAction.run_id == run_id,
                TtrpgCombatAction.user_id == self.user_id,
                TtrpgCombatAction.reversible.is_(True),
                TtrpgCombatAction.undone_by_seq.is_(None),
            )
            .order_by(TtrpgCombatAction.seq.desc())
            .limit(1)
        )
        return target

    async def view(self, run_id: uuid.UUID) -> RunView:
        run = await self._run(run_id)
        rows = await self._rows(run.id)
        party = await self._party([r.party_member_id for r in rows if r.party_member_id])
        views = [
            CombatantView(
                row,
                party[row.party_member_id][0] if row.party_member_id in party else None,
                party[row.party_member_id][1] if row.party_member_id in party else None,
            )
            for row in rows
        ]
        views.sort(
            key=lambda v: (
                v.row.order_index is None,
                v.row.order_index if v.row.order_index is not None else 0,
                v.row.position,
            )
        )
        ties: list[list[uuid.UUID]] = []
        if run.status == "setup":
            totals = {
                v.row.id: v.row.initiative
                for v in views
                if not v.row.removed and v.row.initiative is not None
            }
            ties = tie_groups({k: t for k, t in totals.items() if t is not None})
        due = [
            (v.row.id, name, rnd)
            for v in views
            if not v.row.removed
            for name, rnd in sorted(v.row.condition_reminders.items())
            if run.status in ("active", "paused") and run.round >= rnd and name in v.conditions
        ]
        return RunView(
            run, views, ties, await self._undo_target(run.id), await self._actions(run.id), due
        )

    async def list_runs(
        self, campaign_id: uuid.UUID, *, unfinished_only: bool = False
    ) -> list[TtrpgCombatRun]:
        await self._campaign(campaign_id)
        stmt = select(TtrpgCombatRun).where(
            TtrpgCombatRun.campaign_id == campaign_id, TtrpgCombatRun.user_id == self.user_id
        )
        if unfinished_only:
            stmt = stmt.where(TtrpgCombatRun.status.in_(UNFINISHED))
        return list(await self.session.scalars(stmt.order_by(TtrpgCombatRun.created_at.desc())))

    async def actions(
        self, run_id: uuid.UUID, *, limit: int = HISTORY_LIMIT, before_seq: int | None = None
    ) -> list[TtrpgCombatAction]:
        await self._run(run_id)
        return await self._actions(run_id, limit=limit, before_seq=before_seq)

    async def _campaign(self, campaign_id: uuid.UUID) -> TtrpgCampaign:
        campaign = await self.session.scalar(
            select(TtrpgCampaign).where(
                TtrpgCampaign.id == campaign_id, TtrpgCampaign.user_id == self.user_id
            )
        )
        if campaign is None:
            raise CampaignNotFoundError(str(campaign_id))
        return campaign

    # --- creating a run ---

    async def create_run(
        self,
        campaign_id: uuid.UUID,
        *,
        run_id: uuid.UUID | None = None,
        encounter_id: uuid.UUID | None = None,
        session_id: uuid.UUID | None = None,
        title: str | None = None,
        party_member_ids: list[uuid.UUID] | None = None,
    ) -> tuple[TtrpgCombatRun, bool]:
        """Launch a prepared encounter, or improvise one (no encounter: add combatants in setup).

        Enemies always start fresh from the encounter's copied stats; the party's hit points,
        conditions and resources are *read from* the party's existing play state, not copied.
        """
        campaign = await self._campaign(campaign_id)
        if run_id is not None:
            existing = await self.session.get(TtrpgCombatRun, run_id)
            if existing is not None:
                if existing.user_id != self.user_id or existing.campaign_id != campaign.id:
                    raise CampaignIdTakenError(str(run_id))
                return existing, False
        if campaign.archived_at is not None:
            raise RunValidationError("an archived campaign cannot start a fight")
        unfinished = await self.session.scalar(
            select(TtrpgCombatRun.id).where(
                TtrpgCombatRun.campaign_id == campaign.id, TtrpgCombatRun.status.in_(UNFINISHED)
            )
        )
        if unfinished is not None:
            raise RunExistsError(unfinished)

        encounter: TtrpgEncounter | None = None
        slots: list[TtrpgEncounterSlot] = []
        if encounter_id is not None:
            encounter = await self.session.scalar(
                select(TtrpgEncounter).where(
                    TtrpgEncounter.id == encounter_id,
                    TtrpgEncounter.campaign_id == campaign.id,
                    TtrpgEncounter.user_id == self.user_id,
                )
            )
            if encounter is None:
                raise EncounterNotFoundError(str(encounter_id))
            slots = list(
                await self.session.scalars(
                    select(TtrpgEncounterSlot)
                    .where(TtrpgEncounterSlot.encounter_id == encounter.id)
                    .order_by(TtrpgEncounterSlot.position)
                )
            )
        if session_id is None and encounter is not None:
            session_id = encounter.session_id
        if session_id is not None:
            owned = await self.session.scalar(
                select(TtrpgSession.id).where(
                    TtrpgSession.id == session_id,
                    TtrpgSession.campaign_id == campaign.id,
                    TtrpgSession.user_id == self.user_id,
                )
            )
            if owned is None:
                raise RunValidationError("that session is not part of this campaign")

        wanted = party_member_ids
        if wanted is None and encounter is not None and encounter.party_member_ids:
            wanted = [uuid.UUID(i) for i in encounter.party_member_ids]
        stmt = select(TtrpgPartyMember).where(
            TtrpgPartyMember.campaign_id == campaign.id,
            TtrpgPartyMember.user_id == self.user_id,
            TtrpgPartyMember.archived_at.is_(None),
        )
        if wanted is not None:
            stmt = stmt.where(TtrpgPartyMember.id.in_(wanted))
        members = list(
            await self.session.scalars(
                stmt.order_by(TtrpgPartyMember.created_at, TtrpgPartyMember.id)
            )
        )
        if wanted is not None and {m.id for m in members} != set(wanted):
            raise RunValidationError("party members must be active members of this campaign")

        run = TtrpgCombatRun(
            id=run_id or uuid.uuid4(),
            campaign_id=campaign.id,
            user_id=self.user_id,
            session_id=session_id,
            encounter_id=encounter.id if encounter else None,
            title=(title or (encounter.title if encounter else "Improvised fight")).strip()[:200],
            status="setup",
            encounter_snapshot=(
                {
                    "title": encounter.title,
                    "book_reference": encounter.book_reference,
                    "setup_reminder": encounter.setup_reminder,
                }
                if encounter
                else {}
            ),
        )
        self.session.add(run)
        try:
            await self.session.flush()
        except IntegrityError as exc:
            # a concurrent launch won the one-unfinished-run-per-campaign index
            await self.session.rollback()
            winner = await self.session.scalar(
                select(TtrpgCombatRun.id).where(
                    TtrpgCombatRun.campaign_id == campaign.id,
                    TtrpgCombatRun.status.in_(UNFINISHED),
                )
            )
            if winner is None:
                raise
            raise RunExistsError(winner) from exc

        position = 0
        for member in members:
            self.session.add(
                TtrpgCombatant(
                    run_id=run.id,
                    user_id=self.user_id,
                    kind="party",
                    side="party",
                    party_member_id=member.id,
                    name=member.name,
                    ac=member.ac,
                    max_hp=member.max_hp,
                    initiative_mod=member.initiative_mod,
                    position=position,
                )
            )
            position += 1
        for slot in slots:
            self.session.add(self._npc_row(run.id, position, slot=slot))
            position += 1
        await self.session.flush()
        return run, True

    def _npc_row(
        self,
        run_id: uuid.UUID,
        position: int,
        *,
        slot: TtrpgEncounterSlot | None = None,
        name: str = "",
        ac: int = 0,
        hp: int = 1,
        initiative_mod: int = 0,
        side: str = "enemy",
        snapshot: dict[str, Any] | None = None,
        initiative: int | None = None,
    ) -> TtrpgCombatant:
        if slot is not None:
            name, ac, hp = slot.name, slot.ac, slot.hp
            initiative_mod, side, snapshot = slot.initiative_mod, slot.side, dict(slot.snapshot)
        return TtrpgCombatant(
            id=uuid.uuid4(),
            run_id=run_id,
            user_id=self.user_id,
            kind="npc",
            side=side,
            source_slot_id=slot.id if slot else None,
            name=name,
            ac=ac,
            max_hp=hp,
            hp=hp,
            temp_hp=0,
            initiative_mod=initiative_mod,
            initiative=initiative,
            position=position,
            snapshot=snapshot or {},
        )

    async def _new_npc(
        self, run_id: uuid.UUID, position: int, spec: NewCombatant
    ) -> TtrpgCombatant:
        card: TtrpgCreature | None = None
        if spec.creature_id is not None:
            card = await self.session.scalar(
                select(TtrpgCreature).where(
                    TtrpgCreature.id == spec.creature_id, TtrpgCreature.user_id == self.user_id
                )
            )
            if card is None:
                raise CreatureNotFoundError(str(spec.creature_id))
        elif spec.name is None or spec.ac is None or spec.hp is None:
            raise RunValidationError("a custom combatant needs a name, AC and HP")
        return self._npc_row(
            run_id,
            position,
            name=spec.name or (card.name if card else ""),
            ac=spec.ac if spec.ac is not None else (card.ac if card else 0),
            hp=spec.hp if spec.hp is not None else (card.hp if card else 1),
            initiative_mod=(
                spec.initiative_mod
                if spec.initiative_mod is not None
                else (card.initiative_mod if card else 0)
            ),
            side=spec.side,
            snapshot=snapshot_of(card) if card else {},
            initiative=spec.initiative,
        )

    # --- setup ---

    async def setup(
        self,
        run_id: uuid.UUID,
        *,
        base_revision: int,
        initiative: dict[uuid.UUID, int | None] | None = None,
        add: list[NewCombatant] | None = None,
        set_removed: dict[uuid.UUID, bool] | None = None,
    ) -> TtrpgCombatRun:
        """Edit the roster before the fight starts (initiative totals, extra NPCs, removals)."""
        run = await self._run(run_id, lock=True)
        if run.status != "setup":
            raise RunValidationError("the roster can only be edited before the fight starts")
        if run.revision != base_revision:
            raise CampaignRevisionError(run.revision)
        rows = {r.id: r for r in await self._rows(run.id, lock=True)}
        for combatant_id, total in (initiative or {}).items():
            if combatant_id not in rows:
                raise RunValidationError("unknown combatant")
            if total is not None and not -100 <= total <= 100:
                raise RunValidationError("initiative must be between -100 and 100")
            rows[combatant_id].initiative = total
        for combatant_id, removed in (set_removed or {}).items():
            if combatant_id not in rows:
                raise RunValidationError("unknown combatant")
            rows[combatant_id].removed = removed
        position = max((r.position for r in rows.values()), default=-1)
        for spec in add or []:
            position += 1
            self.session.add(await self._new_npc(run.id, position, spec))
        run.revision += 1
        await self.session.flush()
        return run

    async def start(
        self, run_id: uuid.UUID, *, base_revision: int, tie_order: list[uuid.UUID] | None = None
    ) -> TtrpgCombatRun:
        run = await self._run(run_id, lock=True)
        if run.status != "setup":
            raise RunValidationError("this fight has already started")
        if run.revision != base_revision:
            raise CampaignRevisionError(run.revision)
        rows = [r for r in await self._rows(run.id, lock=True) if not r.removed]
        if not rows:
            raise RunValidationError("add at least one combatant first")
        missing = [r.name for r in rows if r.initiative is None]
        if missing:
            raise RunValidationError(f"enter initiative for: {', '.join(missing)}")
        known = {r.id for r in rows}
        if tie_order and not set(tie_order) <= known:
            raise RunValidationError("the tie order names an unknown combatant")
        order = initial_order(
            {r.id: r.initiative for r in rows if r.initiative is not None},
            {r.id: r.position for r in rows},
            tie_order or (),
        )
        for index, combatant_id in enumerate(order):
            next(r for r in rows if r.id == combatant_id).order_index = index
        seats = [Seat(r.id, r.order_index or 0, True) for r in rows]
        turn = advance(seats, None, 0)
        run.status = "active"
        run.round = turn.round
        run.active_combatant_id = turn.active
        run.started_at = datetime.now(UTC)
        run.revision += 1
        await self._record(
            run,
            kind="start",
            summary="The fight began",
            combatant_id=turn.active,
            reversible=False,
            mutation_key=f"start-{run.revision}",
            request_hash="start",
            tracker=None,
        )
        await self.session.flush()
        return run

    # --- the action pipeline ---

    async def _record(
        self,
        run: TtrpgCombatRun,
        *,
        kind: str,
        summary: str,
        combatant_id: uuid.UUID | None,
        reversible: bool,
        mutation_key: str,
        request_hash: str,
        tracker: Tracker | None,
    ) -> TtrpgCombatAction:
        run.action_seq += 1
        row = TtrpgCombatAction(
            run_id=run.id,
            user_id=self.user_id,
            seq=run.action_seq,
            kind=kind,
            mutation_key=mutation_key,
            request_hash=request_hash,
            combatant_id=combatant_id,
            summary=summary[:500],
            reversible=reversible,
            before=tracker.before if tracker else {},
            after=tracker.after if tracker else {},
        )
        self.session.add(row)
        return row

    async def apply(
        self,
        run_id: uuid.UUID,
        *,
        mutation_key: str,
        base_revision: int,
        request: ActionRequest,
    ) -> ApplyResult:
        run = await self._run(run_id, lock=True)
        fingerprint = _fingerprint(request)
        prior = await self.session.scalar(
            select(TtrpgCombatAction).where(
                TtrpgCombatAction.run_id == run.id, TtrpgCombatAction.mutation_key == mutation_key
            )
        )
        if prior is not None:
            if prior.request_hash != fingerprint:
                raise MutationKeyReusedError("that mutation key was used for a different change")
            return ApplyResult(await self.view(run.id), prior, True)

        allowed = {
            "pause": ("active",),
            "resume": ("paused",),
            "end": ("active", "paused", "setup"),
        }.get(request.kind, ("active",))
        if run.status not in allowed:
            raise RunValidationError(
                "the fight is paused: resume it first"
                if run.status == "paused"
                else f"that is not possible while the fight is {run.status}"
            )
        if run.revision != base_revision:
            raise CampaignRevisionError(run.revision)

        rows = {r.id: r for r in await self._rows(run.id, lock=True)}
        tracker = Tracker()
        handler = _HANDLERS[request.kind]
        outcome = await handler(self, run, rows, request, tracker)
        tracker.finish()
        run.revision += 1
        action = await self._record(
            run,
            kind=request.kind,
            summary=outcome.summary,
            combatant_id=outcome.combatant_id,
            reversible=outcome.reversible,
            mutation_key=mutation_key,
            request_hash=fingerprint,
            tracker=tracker,
        )
        await self.session.flush()
        if run.status == "ended":
            await self._compact(run.id)
        return ApplyResult(await self.view(run.id), action, False)

    async def _compact(self, run_id: uuid.UUID) -> None:
        """Drop the undo payload of a finished fight.

        Nothing in an ended run can be undone, so the stored ``before``/``after`` values are dead
        weight: they are cleared and every action becomes non-reversible. The summaries, kinds,
        numbering and the combatants stay, so the history remains readable. A live or paused fight
        keeps its payload (it is what undo needs), which bounds the storage that history can take.
        """
        await self.session.execute(
            update(TtrpgCombatAction)
            .where(TtrpgCombatAction.run_id == run_id, TtrpgCombatAction.user_id == self.user_id)
            .values(before={}, after={}, reversible=False)
            .execution_options(synchronize_session="fetch")
        )
        await self.session.flush()

    # helpers used by the handlers

    async def party_state(
        self,
        row: TtrpgCombatant,
        request: ActionRequest,
        tracker: Tracker,
    ) -> tuple[TtrpgPartyMember, TtrpgPartyState]:
        """Lock the party member behind a slot and check the client's revision of it."""
        if row.party_member_id is None:
            raise RunValidationError(f"{row.name} is no longer linked to a party member")
        found = await self._party([row.party_member_id], lock=True)
        if row.party_member_id not in found:
            raise RunValidationError(f"{row.name} is no longer linked to a party member")
        member, state = found[row.party_member_id]
        expected = request.party_revisions.get(member.id)
        if expected is None:
            raise RunValidationError(f"send the current revision of {member.name}'s state")
        if state.revision != expected:
            raise PartyRevisionError(member.id, member.name, state.revision)
        del tracker
        return member, state

    # --- undo ---

    async def undo(
        self, run_id: uuid.UUID, *, mutation_key: str, base_revision: int
    ) -> ApplyResult:
        run = await self._run(run_id, lock=True)
        prior = await self.session.scalar(
            select(TtrpgCombatAction).where(
                TtrpgCombatAction.run_id == run.id, TtrpgCombatAction.mutation_key == mutation_key
            )
        )
        if prior is not None:
            if prior.kind != "undo":
                raise MutationKeyReusedError("that mutation key was used for a different change")
            return ApplyResult(await self.view(run.id), prior, True)
        if run.status not in ("active", "paused"):
            raise RunValidationError("nothing can be undone in this fight now")
        if run.revision != base_revision:
            raise CampaignRevisionError(run.revision)
        target = await self._undo_target(run.id)
        if target is None:
            raise NothingToUndoError("there is nothing to undo")

        rows = {r.id: r for r in await self._rows(run.id, lock=True)}
        party_ids = [uuid.UUID(k) for k in target.after.get("party", {})]
        party = await self._party(party_ids, lock=True)

        # 1. conflict check: nothing may have changed the affected state since the action
        problems: list[str] = []
        for key, fields in target.after.get("combatants", {}).items():
            row = rows.get(uuid.UUID(key))
            if row is None:
                problems.append("a combatant is gone")
                continue
            for name, value in fields.items():
                if getattr(row, name) != value:
                    problems.append(f"{row.name}'s {name} changed")
        for key, fields in target.after.get("party", {}).items():
            member_state = party.get(uuid.UUID(key))
            if member_state is None:
                problems.append("a party member is gone")
                continue
            member, state = member_state
            if state.revision != fields.get("_revision"):
                problems.append(f"{member.name} was changed outside this fight")
            else:
                for name, value in fields.items():
                    if name != "_revision" and getattr(state, name) != value:
                        problems.append(f"{member.name}'s {name} changed")
        for name, value in target.after.get("run", {}).items():
            if _json(getattr(run, name)) != value:
                problems.append(f"the fight's {name} changed")
        if problems:
            raise UndoConflictError("; ".join(sorted(set(problems))))

        # 2. restore the recorded 'before' values (the newer revision numbers stay monotonic)
        tracker = Tracker()
        for name, value in target.before.get("run", {}).items():
            if name == "ended_at" and value:
                value = datetime.fromisoformat(value)
            elif name == "active_combatant_id" and value:
                value = uuid.UUID(value)
            tracker.run(run, name, value)
        for key, fields in target.before.get("combatants", {}).items():
            row = rows[uuid.UUID(key)]
            for name, value in fields.items():
                tracker.combatant(row, name, value)
        for key, fields in target.before.get("party", {}).items():
            member, state = party[uuid.UUID(key)]
            for name, value in fields.items():
                if name != "_revision":
                    tracker.party(state, name, value)
        tracker.finish()
        run.revision += 1
        action = await self._record(
            run,
            kind="undo",
            summary=f"Undid: {target.summary}",
            combatant_id=target.combatant_id,
            reversible=False,
            mutation_key=mutation_key,
            request_hash="undo",
            tracker=tracker,
        )
        target.undone_by_seq = action.seq
        await self.session.flush()
        return ApplyResult(await self.view(run.id), action, False)


Rows = dict[uuid.UUID, TtrpgCombatant]


@dataclass(frozen=True)
class Outcome:
    summary: str
    combatant_id: uuid.UUID | None = None
    reversible: bool = True


def _row(rows: dict[uuid.UUID, TtrpgCombatant], request: ActionRequest) -> TtrpgCombatant:
    if request.combatant_id is None:
        raise RunValidationError("combatant_id is required")
    row = rows.get(request.combatant_id)
    if row is None:
        raise RunValidationError("unknown combatant")
    if row.removed:
        raise RunValidationError(f"{row.name} has been removed from the fight")
    return row


def _amount(request: ActionRequest) -> int:
    if request.amount is None:
        raise RunValidationError("amount is required")
    return request.amount


async def _hp_change(
    svc: RunService,
    run: TtrpgCombatRun,
    rows: Rows,
    request: ActionRequest,
    tracker: Tracker,
) -> Outcome:
    row = _row(rows, request)
    kind = request.kind
    if kind == "set_hp":
        if request.hp is None:
            raise RunValidationError("hp is required")
        amount = request.hp
    else:
        amount = _amount(request)
    if row.kind == "party":
        member, state = await svc.party_state(row, request, tracker)
        old_hp, old_temp = state.current_hp, state.temp_hp
        new_hp, new_temp = old_hp, old_temp
        if kind == "damage":
            new_hp, new_temp = rules.apply_damage(old_hp, old_temp, amount)
        elif kind == "heal":
            new_hp = rules.apply_healing(old_hp, member.max_hp, amount)
        elif kind == "temp_hp":
            new_temp = rules.grant_temp_hp(old_temp, amount)
        else:
            if amount > member.max_hp:
                raise RunValidationError("hit points cannot exceed the maximum")
            new_hp = amount
        tracker.party(state, "current_hp", new_hp)
        tracker.party(state, "temp_hp", new_temp)
        if new_hp > 0 and (state.death_save_successes or state.death_save_failures):
            tracker.party(state, "death_save_successes", 0)
            tracker.party(state, "death_save_failures", 0)
        normalize_state(member, state)
    else:
        old_hp, old_temp = row.hp or 0, row.temp_hp or 0
        new_hp, new_temp = old_hp, old_temp
        if kind == "damage":
            new_hp, new_temp = rules.apply_damage(old_hp, old_temp, amount)
        elif kind == "heal":
            new_hp = rules.apply_healing(old_hp, row.max_hp, amount)
        elif kind == "temp_hp":
            new_temp = rules.grant_temp_hp(old_temp, amount)
        else:
            if amount > row.max_hp:
                raise RunValidationError("hit points cannot exceed the maximum")
            new_hp = amount
        tracker.combatant(row, "hp", new_hp)
        tracker.combatant(row, "temp_hp", new_temp)
        if new_hp == 0 and not row.defeated:
            tracker.combatant(row, "defeated", True)
        elif new_hp > 0 and old_hp == 0 and row.defeated:
            tracker.combatant(row, "defeated", False)
    verb = {"damage": "took", "heal": "healed", "temp_hp": "gained temporary", "set_hp": "set to"}[
        kind
    ]
    detail = f"{amount}" if kind != "set_hp" else f"{amount} HP"
    suffix = f" (HP {old_hp} → {new_hp}" + (
        f", temp {old_temp} → {new_temp})" if old_temp != new_temp else ")"
    )
    return Outcome(f"{row.name} {verb} {detail}{suffix}", row.id)


async def _add_condition(
    svc: RunService,
    run: TtrpgCombatRun,
    rows: Rows,
    request: ActionRequest,
    tracker: Tracker,
) -> Outcome:
    row = _row(rows, request)
    name = request.condition
    if name not in rules.CONDITIONS:
        raise RunValidationError("unknown condition")
    assert name is not None
    if row.kind == "party":
        _member, state = await svc.party_state(row, request, tracker)
        present = name in state.conditions
        if not present:
            tracker.party(state, "conditions", sorted({*state.conditions, name}))
    else:
        present = name in row.conditions
        if not present:
            tracker.combatant(row, "conditions", sorted({*row.conditions, name}))
    reminders = dict(row.condition_reminders)
    if request.expires_round is not None and reminders.get(name) != request.expires_round:
        reminders[name] = request.expires_round
        tracker.combatant(row, "condition_reminders", reminders)
    elif present:
        raise RunValidationError(f"{row.name} is already {name}")
    when = f" until round {request.expires_round}" if request.expires_round else ""
    return Outcome(f"{row.name} is {name}{when}", row.id)


async def _remove_condition(
    svc: RunService,
    run: TtrpgCombatRun,
    rows: Rows,
    request: ActionRequest,
    tracker: Tracker,
) -> Outcome:
    row = _row(rows, request)
    name = request.condition
    assert name is None or isinstance(name, str)
    if row.kind == "party":
        _member, state = await svc.party_state(row, request, tracker)
        if name not in state.conditions:
            raise RunValidationError(f"{row.name} is not {name}")
        tracker.party(state, "conditions", [c for c in state.conditions if c != name])
    else:
        if name not in row.conditions:
            raise RunValidationError(f"{row.name} is not {name}")
        tracker.combatant(row, "conditions", [c for c in row.conditions if c != name])
    if name in row.condition_reminders:
        tracker.combatant(
            row,
            "condition_reminders",
            {k: v for k, v in row.condition_reminders.items() if k != name},
        )
    return Outcome(f"{row.name} is no longer {name}", row.id)


async def _death_save(
    svc: RunService,
    run: TtrpgCombatRun,
    rows: Rows,
    request: ActionRequest,
    tracker: Tracker,
) -> Outcome:
    row = _row(rows, request)
    if row.kind != "party":
        raise RunValidationError("only party members make death saves")
    if request.death_save is None:
        raise RunValidationError("death_save is required")
    _member, state = await svc.party_state(row, request, tracker)
    if state.current_hp > 0:
        raise RunValidationError("death saves only apply at 0 hit points")
    successes, failures = state.death_save_successes, state.death_save_failures
    if request.death_save == "success":
        successes = min(rules.DEATH_SAVE_LIMIT, successes + 1)
    elif request.death_save == "failure":
        failures = min(rules.DEATH_SAVE_LIMIT, failures + 1)
    else:
        successes = failures = 0
    if (successes, failures) == (state.death_save_successes, state.death_save_failures):
        raise RunValidationError("nothing to change")
    tracker.party(state, "death_save_successes", successes)
    tracker.party(state, "death_save_failures", failures)
    return Outcome(f"{row.name}: death saves {successes} successes, {failures} failures", row.id)


async def _spend_resource(
    svc: RunService,
    run: TtrpgCombatRun,
    rows: Rows,
    request: ActionRequest,
    tracker: Tracker,
) -> Outcome:
    row = _row(rows, request)
    if row.kind != "party":
        raise RunValidationError("only party members have tracked resources")
    member, state = await svc.party_state(row, request, tracker)
    known = {item["key"]: item for item in member.resources}
    key = request.resource_key
    if key is None or key not in known or request.delta is None:
        raise RunValidationError("unknown resource")
    used = state.resources_used.get(key, 0) + request.delta
    if not 0 <= used <= known[key]["max"]:
        raise RunValidationError(
            f"{known[key]['name']} must stay between 0 and {known[key]['max']}"
        )
    merged: dict[str, int] = {**state.resources_used, key: used}
    updated = {k: v for k, v in merged.items() if v > 0}
    tracker.party(state, "resources_used", updated)
    verb = "used" if request.delta > 0 else "regained"
    return Outcome(
        f"{row.name} {verb} {known[key]['name']} ({known[key]['max'] - used} left)", row.id
    )


def _seats(rows: dict[uuid.UUID, TtrpgCombatant]) -> list[Seat]:
    return [
        Seat(r.id, r.order_index, not r.removed and not r.defeated)
        for r in rows.values()
        if r.order_index is not None
    ]


def _move_turn(
    run: TtrpgCombatRun, rows: dict[uuid.UUID, TtrpgCombatant], tracker: Tracker
) -> Outcome:
    turn = advance(_seats(rows), run.active_combatant_id, run.round)
    if turn.no_eligible:
        tracker.run(run, "status", "ended")
        tracker.run(run, "end_reason", "no_eligible_combatants")
        tracker.run(run, "ended_at", datetime.now(UTC))
        tracker.run(run, "active_combatant_id", None)
        return Outcome("Nobody is left to act: the fight ended", None)
    tracker.run(run, "active_combatant_id", turn.active)
    tracker.run(run, "round", turn.round)
    assert turn.active is not None
    return Outcome(f"Round {turn.round}: {rows[turn.active].name}'s turn", turn.active)


async def _next_turn(
    svc: RunService,
    run: TtrpgCombatRun,
    rows: Rows,
    request: ActionRequest,
    tracker: Tracker,
) -> Outcome:
    return _move_turn(run, rows, tracker)


async def _set_defeated(
    svc: RunService,
    run: TtrpgCombatRun,
    rows: Rows,
    request: ActionRequest,
    tracker: Tracker,
) -> Outcome:
    row = _row(rows, request)
    if request.defeated is None:
        raise RunValidationError("defeated is required")
    if row.kind == "party":
        raise RunValidationError("a party member is removed, not defeated")
    if row.defeated == request.defeated:
        raise RunValidationError("nothing to change")
    tracker.combatant(row, "defeated", request.defeated)
    return Outcome(
        f"{row.name} {'was defeated' if request.defeated else 'is back in the fight'}", row.id
    )


async def _remove(
    svc: RunService,
    run: TtrpgCombatRun,
    rows: Rows,
    request: ActionRequest,
    tracker: Tracker,
) -> Outcome:
    row = _row(rows, request)
    tracker.combatant(row, "removed", True)
    summary = f"{row.name} left the fight"
    if run.active_combatant_id == row.id:
        # the active seat is gone: its turn passes to the next eligible one
        turn = _move_turn(run, rows, tracker)
        summary = f"{summary}. {turn.summary}"
        return Outcome(summary, row.id)
    if not any(
        not r.removed and not r.defeated and r.id != row.id
        for r in rows.values()
        if r.order_index is not None
    ):
        tracker.run(run, "status", "ended")
        tracker.run(run, "end_reason", "no_eligible_combatants")
        tracker.run(run, "ended_at", datetime.now(UTC))
        tracker.run(run, "active_combatant_id", None)
        summary = f"{summary}. Nobody is left to act: the fight ended"
    return Outcome(summary, row.id)


async def _restore(
    svc: RunService,
    run: TtrpgCombatRun,
    rows: Rows,
    request: ActionRequest,
    tracker: Tracker,
) -> Outcome:
    if request.combatant_id is None or request.combatant_id not in rows:
        raise RunValidationError("unknown combatant")
    row = rows[request.combatant_id]
    if not row.removed:
        raise RunValidationError(f"{row.name} is already in the fight")
    tracker.combatant(row, "removed", False)
    return Outcome(f"{row.name} rejoined the fight", row.id)


async def _add_combatant(
    svc: RunService,
    run: TtrpgCombatRun,
    rows: Rows,
    request: ActionRequest,
    tracker: Tracker,
) -> Outcome:
    spec = request.new_combatant
    if spec is None or spec.initiative is None:
        raise RunValidationError("a reinforcement needs its initiative total")
    position = max((r.position for r in rows.values()), default=-1) + 1
    new = await svc._new_npc(run.id, position, spec)
    ordered = sorted(
        (r for r in rows.values() if r.order_index is not None), key=lambda r: r.order_index or 0
    )
    index = insertion_index([(r.id, r.initiative) for r in ordered], spec.initiative)
    for row in ordered:
        if (row.order_index or 0) >= index:
            tracker.combatant(row, "order_index", (row.order_index or 0) + 1)
    # created hidden, then revealed through the tracker so an undo can hide it again
    new.removed = True
    new.order_index = None
    svc.session.add(new)
    await svc.session.flush()
    rows[new.id] = new
    tracker.combatant(new, "order_index", index)
    tracker.combatant(new, "removed", False)
    return Outcome(f"{new.name} joined the fight (initiative {spec.initiative})", new.id)


async def _reorder(
    svc: RunService,
    run: TtrpgCombatRun,
    rows: Rows,
    request: ActionRequest,
    tracker: Tracker,
) -> Outcome:
    wanted = request.order or []
    live = [r for r in rows.values() if r.order_index is not None and not r.removed]
    if sorted(wanted, key=str) != sorted((r.id for r in live), key=str):
        raise RunValidationError("the new order must list every combatant in the fight once")
    slots = sorted(r.order_index or 0 for r in live)
    by_id = {r.id: r for r in live}
    for slot, combatant_id in zip(slots, wanted, strict=True):
        if by_id[combatant_id].order_index != slot:
            tracker.combatant(by_id[combatant_id], "order_index", slot)
    if not tracker.after["combatants"]:
        raise RunValidationError("the order is unchanged")
    return Outcome("The turn order was rearranged", None)


async def _pause(
    svc: RunService,
    run: TtrpgCombatRun,
    rows: Rows,
    request: ActionRequest,
    tracker: Tracker,
) -> Outcome:
    tracker.run(run, "status", "paused")
    return Outcome("The fight was paused", None, reversible=False)


async def _resume(
    svc: RunService,
    run: TtrpgCombatRun,
    rows: Rows,
    request: ActionRequest,
    tracker: Tracker,
) -> Outcome:
    tracker.run(run, "status", "active")
    return Outcome("The fight resumed", None, reversible=False)


async def _end(
    svc: RunService,
    run: TtrpgCombatRun,
    rows: Rows,
    request: ActionRequest,
    tracker: Tracker,
) -> Outcome:
    was_setup = run.status == "setup"
    tracker.run(run, "status", "ended")
    tracker.run(run, "end_reason", "cancelled" if was_setup else "ended_by_dm")
    tracker.run(run, "ended_at", datetime.now(UTC))
    tracker.run(run, "active_combatant_id", None)
    if request.outcome and request.outcome.strip():
        tracker.run(run, "outcome", request.outcome.strip())
    return Outcome(
        "The fight was cancelled" if was_setup else "The fight ended", None, reversible=False
    )


_HANDLERS = {
    "damage": _hp_change,
    "heal": _hp_change,
    "temp_hp": _hp_change,
    "set_hp": _hp_change,
    "add_condition": _add_condition,
    "remove_condition": _remove_condition,
    "death_save": _death_save,
    "spend_resource": _spend_resource,
    "next_turn": _next_turn,
    "set_defeated": _set_defeated,
    "remove_combatant": _remove,
    "restore_combatant": _restore,
    "add_combatant": _add_combatant,
    "reorder": _reorder,
    "pause": _pause,
    "resume": _resume,
    "end": _end,
}
