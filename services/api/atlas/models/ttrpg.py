"""TTRPG module records (TTRPG-02 onward).

Notes stay Markdown files; these tables hold only structured state and reference notes by their
stable id, so a rename or move of a note never breaks the link. A deleted note is reported as
missing and can be relinked; the campaign is never lost with it.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
    Uuid,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base
from .base import TimestampMixin

RULES_PRESETS = ("dnd5e-2014",)
SESSION_STATUSES = ("planned", "active", "done")


class TtrpgCampaign(Base, TimestampMixin):
    __tablename__ = "ttrpg_campaigns"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    rules_preset: Mapped[str] = mapped_column(
        String(32), nullable=False, default="dnd5e-2014", server_default="dnd5e-2014"
    )
    book_title: Mapped[str | None] = mapped_column(String(200))
    #: note folder (relative to the notes root) the campaign scaffolds into
    folder: Mapped[str] = mapped_column(String(512), nullable=False)
    #: the campaign home note; ``NULL`` only while a scaffold is incomplete
    home_note_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("notes.id", ondelete="SET NULL")
    )
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")

    __table_args__ = (
        UniqueConstraint("user_id", "folder", name="uq_ttrpg_campaigns_user_folder"),
        CheckConstraint("rules_preset IN ('dnd5e-2014')", name="rules_preset_known"),
        CheckConstraint("revision >= 1", name="revision_positive"),
    )


class TtrpgSession(Base, TimestampMixin):
    __tablename__ = "ttrpg_sessions"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    campaign_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("ttrpg_campaigns.id", ondelete="CASCADE"), nullable=False, index=True
    )
    #: denormalised so every read is scoped to the caller without a join
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    note_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("notes.id", ondelete="SET NULL")
    )
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    session_date: Mapped[date | None] = mapped_column(Date)
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="planned", server_default="planned"
    )
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")

    __table_args__ = (
        UniqueConstraint("campaign_id", "sequence", name="uq_ttrpg_sessions_campaign_sequence"),
        CheckConstraint("status IN ('planned','active','done')", name="status_known"),
        CheckConstraint("sequence >= 1", name="sequence_positive"),
        CheckConstraint("revision >= 1", name="revision_positive"),
    )


class TtrpgPartyMember(Base, TimestampMixin):
    """A reusable character card (TTRPG-03). Archived, never deleted, so history still resolves."""

    __tablename__ = "ttrpg_party_members"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    campaign_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("ttrpg_campaigns.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    role: Mapped[str] = mapped_column(String(16), nullable=False, default="pc", server_default="pc")
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    level: Mapped[int | None] = mapped_column(Integer)
    ac: Mapped[int] = mapped_column(Integer, nullable=False)
    max_hp: Mapped[int] = mapped_column(Integer, nullable=False)
    speed: Mapped[int | None] = mapped_column(Integer)
    initiative_mod: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    passive_perception: Mapped[int | None] = mapped_column(Integer)
    attacks: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb")
    )
    abilities: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb")
    )
    #: resource definitions: ``[{key, name, max, reset}]``; usage lives in the play state
    resources: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb")
    )
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")

    __table_args__ = (
        CheckConstraint("role IN ('pc','companion')", name="role_known"),
        CheckConstraint("max_hp >= 1", name="max_hp_positive"),
        CheckConstraint("ac >= 0", name="ac_nonneg"),
        CheckConstraint("revision >= 1", name="revision_positive"),
    )


class TtrpgPartyState(Base, TimestampMixin):
    """What changes during play for one party member; the single copy combat reads and writes."""

    __tablename__ = "ttrpg_party_state"

    member_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("ttrpg_party_members.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    current_hp: Mapped[int] = mapped_column(Integer, nullable=False)
    temp_hp: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    conditions: Mapped[list[str]] = mapped_column(
        JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb")
    )
    exhaustion_level: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    death_save_successes: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    death_save_failures: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    #: ``{resource key: uses spent}``; only non-zero entries are stored
    resources_used: Mapped[dict[str, int]] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")

    __table_args__ = (
        CheckConstraint("current_hp >= 0", name="current_hp_nonneg"),
        CheckConstraint("temp_hp >= 0", name="temp_hp_nonneg"),
        CheckConstraint("exhaustion_level BETWEEN 0 AND 6", name="exhaustion_range"),
        CheckConstraint("death_save_successes BETWEEN 0 AND 3", name="death_successes_range"),
        CheckConstraint("death_save_failures BETWEEN 0 AND 3", name="death_failures_range"),
        CheckConstraint("revision >= 1", name="revision_positive"),
    )


class TtrpgCreature(Base, TimestampMixin):
    """A creature card (TTRPG-04): manual, imported from the SRD, or a variant of either.

    Imported cards are read-only snapshots with provenance (``source``, ``source_edition``,
    ``external_id``, ``attribution``); the only way an upstream change reaches one is the explicit
    refresh. To change an imported card, duplicate it into an editable variant.
    """

    __tablename__ = "ttrpg_creatures"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    ac: Mapped[int] = mapped_column(Integer, nullable=False)
    hp: Mapped[int] = mapped_column(Integer, nullable=False)
    speed: Mapped[str | None] = mapped_column(String(200))
    initiative_mod: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    challenge_rating: Mapped[str | None] = mapped_column(String(8))
    size: Mapped[str | None] = mapped_column(String(32))
    creature_type: Mapped[str | None] = mapped_column(String(120))
    traits: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb")
    )
    #: ``[{name, text, kind, to_hit, damage}]`` with ``kind`` action/reaction/legendary
    actions: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb")
    )
    source: Mapped[str] = mapped_column(
        String(16), nullable=False, default="manual", server_default="manual"
    )
    source_edition: Mapped[str | None] = mapped_column(String(16))
    external_id: Mapped[str | None] = mapped_column(String(100))
    attribution: Mapped[str | None] = mapped_column(String(1000))
    imported_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    derived_from_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("ttrpg_creatures.id", ondelete="SET NULL")
    )
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")

    __table_args__ = (
        CheckConstraint("source IN ('manual','srd')", name="source_known"),
        CheckConstraint(
            "(source = 'srd') = (external_id IS NOT NULL)", name="external_id_matches_source"
        ),
        CheckConstraint("ac >= 0", name="ac_nonneg"),
        CheckConstraint("hp >= 1", name="hp_positive"),
        CheckConstraint("revision >= 1", name="revision_positive"),
        Index(
            "uq_ttrpg_creatures_user_srd",
            "user_id",
            "source_edition",
            "external_id",
            unique=True,
            postgresql_where=text("source = 'srd'"),
        ),
    )


class TtrpgEncounter(Base, TimestampMixin):
    """A prepared encounter (TTRPG-05): reusable, with copied stats that only an explicit refresh
    touches. It is *prep*; a combat run (TTRPG-06) snapshots it again when launched."""

    __tablename__ = "ttrpg_encounters"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    campaign_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("ttrpg_campaigns.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    #: free text in the DM's own copy's pagination/room labels
    book_reference: Mapped[str | None] = mapped_column(String(300))
    setup_reminder: Mapped[str | None] = mapped_column(String(2000))
    session_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("ttrpg_sessions.id", ondelete="SET NULL"), index=True
    )
    location_note_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("notes.id", ondelete="SET NULL")
    )
    #: the selected party participants (ids of ``ttrpg_party_members`` of this campaign)
    party_member_ids: Mapped[list[str]] = mapped_column(
        JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb")
    )
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")

    __table_args__ = (CheckConstraint("revision >= 1", name="revision_positive"),)


class TtrpgEncounterSlot(Base, TimestampMixin):
    """One independent combatant slot of an encounter, with its own copied stats."""

    __tablename__ = "ttrpg_encounter_slots"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    encounter_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("ttrpg_encounters.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    side: Mapped[str] = mapped_column(
        String(8), nullable=False, default="enemy", server_default="enemy"
    )
    #: the card this slot was copied from; ``NULL`` for a fully custom entry
    creature_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("ttrpg_creatures.id", ondelete="SET NULL")
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    ac: Mapped[int] = mapped_column(Integer, nullable=False)
    hp: Mapped[int] = mapped_column(Integer, nullable=False)
    initiative_mod: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    #: which of name/ac/hp/initiative_mod the DM set by hand; a refresh never touches these
    overrides: Mapped[list[str]] = mapped_column(
        JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb")
    )
    #: the copied card at preparation time (traits, actions, provenance, attribution)
    snapshot: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )

    __table_args__ = (
        UniqueConstraint("encounter_id", "position", name="uq_ttrpg_slots_encounter_position"),
        CheckConstraint("side IN ('enemy','ally')", name="side_known"),
        CheckConstraint("ac >= 0", name="ac_nonneg"),
        CheckConstraint("hp >= 1", name="hp_positive"),
    )


RUN_STATUSES = ("setup", "active", "paused", "ended")
UNFINISHED_STATUSES = ("setup", "active", "paused")


class TtrpgCombatRun(Base, TimestampMixin):
    """A combat run (TTRPG-06): initiative roster, turn, round and history of one fight.

    At most one *unfinished* run (``setup``/``active``/``paused``) exists per campaign (partial
    unique index). Everything needed to read the run later is copied into it, so editing or
    archiving the encounter, the cards or the party never rewrites history.
    """

    __tablename__ = "ttrpg_combat_runs"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    campaign_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("ttrpg_campaigns.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    session_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("ttrpg_sessions.id", ondelete="SET NULL")
    )
    encounter_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("ttrpg_encounters.id", ondelete="SET NULL")
    )
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    status: Mapped[str] = mapped_column(
        String(8), nullable=False, default="setup", server_default="setup"
    )
    round: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    #: the combatant whose turn it is (no foreign key: history must outlive roster edits)
    active_combatant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    #: copied from the encounter at launch (book reference, setup reminder), for reading later
    encounter_snapshot: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    outcome: Mapped[str | None] = mapped_column(String(2000))
    end_reason: Mapped[str | None] = mapped_column(String(32))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    #: bumped by every confirmed change; clients send the one they saw
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    #: the next action sequence number (actions are numbered 1, 2, 3 ... per run)
    action_seq: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")

    __table_args__ = (
        CheckConstraint("status IN ('setup','active','paused','ended')", name="status_known"),
        CheckConstraint("round >= 0", name="round_nonneg"),
        CheckConstraint("revision >= 1", name="revision_positive"),
        Index(
            "uq_ttrpg_combat_runs_one_unfinished",
            "campaign_id",
            unique=True,
            postgresql_where=text("status IN ('setup','active','paused')"),
        ),
    )


class TtrpgCombatant(Base, TimestampMixin):
    """One roster slot of a run, with a stable run-local id.

    An ``npc`` owns its hit points and conditions here. A ``party`` slot owns **none**: it points to
    the party member, whose play state (``ttrpg_party_state``) is the single copy.
    """

    __tablename__ = "ttrpg_combatants"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    run_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("ttrpg_combat_runs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    kind: Mapped[str] = mapped_column(String(8), nullable=False)
    side: Mapped[str] = mapped_column(String(8), nullable=False)
    party_member_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("ttrpg_party_members.id", ondelete="SET NULL")
    )
    #: the slot this was launched from (informational)
    source_slot_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    ac: Mapped[int] = mapped_column(Integer, nullable=False)
    max_hp: Mapped[int] = mapped_column(Integer, nullable=False)
    #: NPC only; ``NULL`` for a party slot (read the party state)
    hp: Mapped[int | None] = mapped_column(Integer)
    temp_hp: Mapped[int | None] = mapped_column(Integer)
    conditions: Mapped[list[str]] = mapped_column(
        JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb")
    )
    #: ``{condition: round}``: remind the DM when the run reaches that round (never auto-removes)
    condition_reminders: Mapped[dict[str, int]] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    initiative_mod: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    initiative: Mapped[int | None] = mapped_column(Integer)
    #: turn order (0-based); ``NULL`` until initiative is confirmed at the start
    order_index: Mapped[int | None] = mapped_column(Integer)
    #: roster position at creation; the last tie-break
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    defeated: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    removed: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    #: the copied card (traits, actions, provenance) for an NPC
    snapshot: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )

    __table_args__ = (
        CheckConstraint("kind IN ('npc','party')", name="kind_known"),
        CheckConstraint("side IN ('enemy','ally','party')", name="side_known"),
        CheckConstraint("(kind = 'npc') = (hp IS NOT NULL)", name="npc_owns_hp"),
        CheckConstraint("max_hp >= 1", name="max_hp_positive"),
    )


class TtrpgCombatAction(Base):
    """A confirmed change in a run: the history, and what an undo needs.

    ``before``/``after`` hold exactly the fields the action changed (combatants, run and party
    state), so an undo can restore them and can tell whether something else changed them since.
    ``mutation_key`` makes a retried request a replay instead of a second application.
    """

    __tablename__ = "ttrpg_combat_actions"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    run_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("ttrpg_combat_runs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    seq: Mapped[int] = mapped_column(Integer, nullable=False)
    kind: Mapped[str] = mapped_column(String(24), nullable=False)
    mutation_key: Mapped[str] = mapped_column(String(64), nullable=False)
    #: fingerprint of the request, so a reused key with a different request is refused
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    combatant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    summary: Mapped[str] = mapped_column(String(500), nullable=False)
    reversible: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    before: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    after: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    #: the undo that reverted this action (``NULL`` while it stands)
    undone_by_seq: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        UniqueConstraint("run_id", "seq", name="uq_ttrpg_actions_run_seq"),
        UniqueConstraint("run_id", "mutation_key", name="uq_ttrpg_actions_run_key"),
    )


__all__ = [
    "RULES_PRESETS",
    "RUN_STATUSES",
    "SESSION_STATUSES",
    "UNFINISHED_STATUSES",
    "TtrpgCampaign",
    "TtrpgCombatAction",
    "TtrpgCombatRun",
    "TtrpgCombatant",
    "TtrpgCreature",
    "TtrpgEncounter",
    "TtrpgEncounterSlot",
    "TtrpgPartyMember",
    "TtrpgPartyState",
    "TtrpgSession",
]
