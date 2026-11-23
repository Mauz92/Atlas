"""The TTRPG part of a full export: an open, versioned JSON document (TTRPG-07).

``ttrpg.json`` (``format: atlas.ttrpg-export``, ``version: 1``) is written into the export set only
for an owner who has TTRPG data, next to ``data.json`` and ``notes.json``. It carries every
structured record of the module (campaigns, sessions, party cards and play state, creature cards,
encounters and slots, combat runs with their combatants and full action history) and **references
notes by id and path**: the prose itself is in the Markdown files under ``notes/``.

Imported SRD material keeps its provenance, and the document carries the SRD 5.1 attribution
notice whenever any such card exists. Additive changes (a new optional key) do not bump the version;
a consumer must tolerate unknown fields (same contract as ``docs/DECISIONS.md`` ADR-0026/0042).
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable
from datetime import date, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import (
    NoteIndex,
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
from .srd import ATTRIBUTION

TTRPG_FORMAT = "atlas.ttrpg-export"
TTRPG_VERSION = 1
TTRPG_FILENAME = "ttrpg.json"


def _id(value: uuid.UUID | None) -> str | None:
    return None if value is None else str(value)


def _when(value: datetime | date | None) -> str | None:
    return None if value is None else value.isoformat()


def _note(note_id: uuid.UUID | None, notes: dict[uuid.UUID, NoteIndex]) -> dict[str, Any] | None:
    if note_id is None:
        return None
    note = notes.get(note_id)
    live = note is not None and note.deleted_at is None
    return {"id": str(note_id), "path": note.path if live and note else None, "missing": not live}


def _creature(card: TtrpgCreature) -> dict[str, Any]:
    return {
        "id": str(card.id),
        "name": card.name,
        "ac": card.ac,
        "hp": card.hp,
        "speed": card.speed,
        "initiative_mod": card.initiative_mod,
        "challenge_rating": card.challenge_rating,
        "size": card.size,
        "creature_type": card.creature_type,
        "traits": card.traits,
        "actions": card.actions,
        "source": card.source,
        "source_edition": card.source_edition,
        "external_id": card.external_id,
        "attribution": card.attribution,
        "imported_at": _when(card.imported_at),
        "derived_from_id": _id(card.derived_from_id),
        "archived_at": _when(card.archived_at),
        "revision": card.revision,
    }


def _member(member: TtrpgPartyMember, state: TtrpgPartyState | None) -> dict[str, Any]:
    return {
        "id": str(member.id),
        "role": member.role,
        "name": member.name,
        "level": member.level,
        "ac": member.ac,
        "max_hp": member.max_hp,
        "speed": member.speed,
        "initiative_mod": member.initiative_mod,
        "passive_perception": member.passive_perception,
        "attacks": member.attacks,
        "abilities": member.abilities,
        "resources": member.resources,
        "archived_at": _when(member.archived_at),
        "revision": member.revision,
        "state": None
        if state is None
        else {
            "current_hp": state.current_hp,
            "temp_hp": state.temp_hp,
            "conditions": state.conditions,
            "exhaustion_level": state.exhaustion_level,
            "death_save_successes": state.death_save_successes,
            "death_save_failures": state.death_save_failures,
            "resources_used": state.resources_used,
            "revision": state.revision,
        },
    }


def _encounter(
    encounter: TtrpgEncounter,
    slots: Iterable[TtrpgEncounterSlot],
    notes: dict[uuid.UUID, NoteIndex],
) -> dict[str, Any]:
    return {
        "id": str(encounter.id),
        "title": encounter.title,
        "book_reference": encounter.book_reference,
        "setup_reminder": encounter.setup_reminder,
        "session_id": _id(encounter.session_id),
        "location_note": _note(encounter.location_note_id, notes),
        "party_member_ids": list(encounter.party_member_ids),
        "archived_at": _when(encounter.archived_at),
        "revision": encounter.revision,
        "slots": [
            {
                "id": str(slot.id),
                "position": slot.position,
                "side": slot.side,
                "creature_id": _id(slot.creature_id),
                "name": slot.name,
                "ac": slot.ac,
                "hp": slot.hp,
                "initiative_mod": slot.initiative_mod,
                "overrides": slot.overrides,
                "snapshot": slot.snapshot,
            }
            for slot in slots
        ],
    }


def _run(
    run: TtrpgCombatRun,
    combatants: Iterable[TtrpgCombatant],
    actions: Iterable[TtrpgCombatAction],
) -> dict[str, Any]:
    return {
        "id": str(run.id),
        "title": run.title,
        "status": run.status,
        "round": run.round,
        "active_combatant_id": _id(run.active_combatant_id),
        "session_id": _id(run.session_id),
        "encounter_id": _id(run.encounter_id),
        "encounter_snapshot": run.encounter_snapshot,
        "outcome": run.outcome,
        "end_reason": run.end_reason,
        "started_at": _when(run.started_at),
        "ended_at": _when(run.ended_at),
        "revision": run.revision,
        "combatants": [
            {
                "id": str(c.id),
                "kind": c.kind,
                "side": c.side,
                "party_member_id": _id(c.party_member_id),
                "name": c.name,
                "ac": c.ac,
                "max_hp": c.max_hp,
                "hp": c.hp,
                "temp_hp": c.temp_hp,
                "conditions": c.conditions,
                "condition_reminders": c.condition_reminders,
                "initiative_mod": c.initiative_mod,
                "initiative": c.initiative,
                "order_index": c.order_index,
                "defeated": c.defeated,
                "removed": c.removed,
                "snapshot": c.snapshot,
            }
            for c in combatants
        ],
        "actions": [
            {
                "seq": a.seq,
                "kind": a.kind,
                "combatant_id": _id(a.combatant_id),
                "summary": a.summary,
                "reversible": a.reversible,
                "undone_by_seq": a.undone_by_seq,
                "created_at": _when(a.created_at),
                "before": a.before,
                "after": a.after,
            }
            for a in actions
        ],
    }


async def collect_ttrpg_document(
    session: AsyncSession, user_id: uuid.UUID, *, generated_at: datetime
) -> tuple[dict[str, Any], dict[str, int]] | None:
    """The owner's TTRPG document and its counts, or ``None`` when there is nothing to export.

    Must run inside the export's consistent-snapshot transaction. Every query is filtered on the
    owner's id.
    """

    async def rows(model: Any, *order: Any) -> list[Any]:
        stmt = select(model).where(model.user_id == user_id)
        return list(await session.scalars(stmt.order_by(*order)))

    campaigns: list[TtrpgCampaign] = await rows(TtrpgCampaign, TtrpgCampaign.created_at)
    creatures: list[TtrpgCreature] = await rows(TtrpgCreature, TtrpgCreature.name, TtrpgCreature.id)
    if not campaigns and not creatures:
        return None
    sessions: list[TtrpgSession] = await rows(TtrpgSession, TtrpgSession.sequence)
    members: list[TtrpgPartyMember] = await rows(TtrpgPartyMember, TtrpgPartyMember.created_at)
    states = {s.member_id: s for s in await rows(TtrpgPartyState, TtrpgPartyState.member_id)}
    encounters: list[TtrpgEncounter] = await rows(TtrpgEncounter, TtrpgEncounter.created_at)
    slots: list[TtrpgEncounterSlot] = await rows(TtrpgEncounterSlot, TtrpgEncounterSlot.position)
    runs: list[TtrpgCombatRun] = await rows(TtrpgCombatRun, TtrpgCombatRun.created_at)
    combatants: list[TtrpgCombatant] = await rows(TtrpgCombatant, TtrpgCombatant.position)
    actions: list[TtrpgCombatAction] = await rows(TtrpgCombatAction, TtrpgCombatAction.seq)

    note_ids = {c.home_note_id for c in campaigns} | {s.note_id for s in sessions}
    note_ids |= {e.location_note_id for e in encounters}
    note_ids.discard(None)
    notes: dict[uuid.UUID, NoteIndex] = {}
    if note_ids:
        found = await session.scalars(
            select(NoteIndex).where(NoteIndex.id.in_(note_ids), NoteIndex.user_id == user_id)
        )
        notes = {n.id: n for n in found}

    campaign_docs: list[dict[str, Any]] = []
    for campaign in campaigns:
        mine_runs = [r for r in runs if r.campaign_id == campaign.id]
        campaign_docs.append(
            {
                "id": str(campaign.id),
                "title": campaign.title,
                "rules_preset": campaign.rules_preset,
                "book_title": campaign.book_title,
                "folder": campaign.folder,
                "archived_at": _when(campaign.archived_at),
                "revision": campaign.revision,
                "home_note": _note(campaign.home_note_id, notes),
                "sessions": [
                    {
                        "id": str(s.id),
                        "sequence": s.sequence,
                        "title": s.title,
                        "session_date": _when(s.session_date),
                        "status": s.status,
                        "note": _note(s.note_id, notes),
                    }
                    for s in sessions
                    if s.campaign_id == campaign.id
                ],
                "party": [
                    _member(m, states.get(m.id)) for m in members if m.campaign_id == campaign.id
                ],
                "encounters": [
                    _encounter(e, [s for s in slots if s.encounter_id == e.id], notes)
                    for e in encounters
                    if e.campaign_id == campaign.id
                ],
                "runs": [
                    _run(
                        r,
                        [c for c in combatants if c.run_id == r.id],
                        [a for a in actions if a.run_id == r.id],
                    )
                    for r in mine_runs
                ],
            }
        )
    uses_srd = any(c.attribution for c in creatures)
    document: dict[str, Any] = {
        "format": TTRPG_FORMAT,
        "version": TTRPG_VERSION,
        "generated_at": generated_at.isoformat(),
        "attribution": ATTRIBUTION if uses_srd else None,
        "campaigns": campaign_docs,
        "creatures": [_creature(c) for c in creatures],
    }
    counts = {
        "ttrpg_campaigns": len(campaigns),
        "ttrpg_party_members": len(members),
        "ttrpg_creatures": len(creatures),
        "ttrpg_encounters": len(encounters),
        "ttrpg_runs": len(runs),
    }
    return document, counts
