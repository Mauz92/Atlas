"""``f2c8b4d6e1a3`` (TTRPG campaigns and sessions): clean up/down and constraints (TTRPG-02)."""

from __future__ import annotations

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from atlas.db import session_scope
from atlas.migrations import downgrade, upgrade


async def test_tables_exist_start_empty_and_enforce_constraints_then_downgrade_keeps_notes() -> (
    None
):
    downgrade("e1f7a3c9d5b2")
    try:
        async with session_scope() as session:
            await session.execute(
                text(
                    "INSERT INTO users (id, email, display_name, password_hash) "
                    "VALUES ('00000000-0000-0000-0000-0000000000a1', 'm@example.com', 'M', 'x')"
                )
            )
            await session.execute(
                text(
                    "INSERT INTO notes (id, user_id, path, title, content_hash) VALUES "
                    "('00000000-0000-0000-0000-0000000000b1', "
                    "'00000000-0000-0000-0000-0000000000a1', 'n.md', 'n', 'h')"
                )
            )
        upgrade("head")
        async with session_scope() as session:
            for table in ("ttrpg_campaigns", "ttrpg_sessions"):
                count = (await session.execute(text(f"SELECT count(*) FROM {table}"))).scalar()
                assert count == 0
            await session.execute(
                text(
                    "INSERT INTO ttrpg_campaigns (id, user_id, title, folder, home_note_id) VALUES "
                    "('00000000-0000-0000-0000-0000000000c1', "
                    "'00000000-0000-0000-0000-0000000000a1', 'C', 'F', "
                    "'00000000-0000-0000-0000-0000000000b1')"
                )
            )
        # one folder per owner; unknown preset; sequence must be positive
        for sql in (
            "INSERT INTO ttrpg_campaigns (id, user_id, title, folder) VALUES (gen_random_uuid(), "
            "'00000000-0000-0000-0000-0000000000a1', 'D', 'F')",
            "INSERT INTO ttrpg_campaigns (id, user_id, title, folder, rules_preset) VALUES "
            "(gen_random_uuid(), '00000000-0000-0000-0000-0000000000a1', 'D', 'G', 'x')",
            "INSERT INTO ttrpg_sessions (id, campaign_id, user_id, title, sequence) VALUES "
            "(gen_random_uuid(), '00000000-0000-0000-0000-0000000000c1', "
            "'00000000-0000-0000-0000-0000000000a1', 'S', 0)",
        ):
            with pytest.raises(IntegrityError):
                async with session_scope() as session:
                    await session.execute(text(sql))
        # a hard-deleted note clears the link instead of the campaign
        async with session_scope() as session:
            await session.execute(
                text("DELETE FROM notes WHERE id = '00000000-0000-0000-0000-0000000000b1'")
            )
            home = (
                await session.execute(text("SELECT home_note_id FROM ttrpg_campaigns"))
            ).scalar()
            assert home is None
        downgrade("e1f7a3c9d5b2")
        async with session_scope() as session:
            assert (await session.execute(text("SELECT count(*) FROM users"))).scalar() == 1
    finally:
        upgrade("head")
        async with session_scope() as session:
            await session.execute(text("DELETE FROM users WHERE email = 'm@example.com'"))


async def test_party_tables_enforce_constraints_cascade_and_downgrade_keeps_campaigns() -> None:
    downgrade("f2c8b4d6e1a3")
    try:
        async with session_scope() as session:
            await session.execute(
                text(
                    "INSERT INTO users (id, email, display_name, password_hash) "
                    "VALUES ('00000000-0000-0000-0000-0000000000a2', 'p@example.com', 'P', 'x')"
                )
            )
            await session.execute(
                text(
                    "INSERT INTO ttrpg_campaigns (id, user_id, title, folder) VALUES "
                    "('00000000-0000-0000-0000-0000000000c2', "
                    "'00000000-0000-0000-0000-0000000000a2', 'C', 'F2')"
                )
            )
        upgrade("head")
        member = (
            "INSERT INTO ttrpg_party_members (id, campaign_id, user_id, name, ac, max_hp) VALUES "
            "('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c2', "
            "'00000000-0000-0000-0000-0000000000a2', 'M', 10, 12)"
        )
        state = (
            "INSERT INTO ttrpg_party_state (member_id, user_id, current_hp) VALUES "
            "('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a2', 12)"
        )
        async with session_scope() as session:
            await session.execute(text(member))
            await session.execute(text(state))
            row = (
                await session.execute(
                    text(
                        "SELECT attacks, resources_used, conditions FROM ttrpg_party_state s "
                        "JOIN ttrpg_party_members m ON m.id = s.member_id"
                    )
                )
            ).one()
            assert row.attacks == [] and row.resources_used == {} and row.conditions == []
        for sql in (
            "UPDATE ttrpg_party_state SET current_hp = -1",
            "UPDATE ttrpg_party_state SET death_save_failures = 4",
            "UPDATE ttrpg_party_state SET exhaustion_level = 7",
            "UPDATE ttrpg_party_members SET max_hp = 0",
            "UPDATE ttrpg_party_members SET role = 'boss'",
        ):
            with pytest.raises(IntegrityError):
                async with session_scope() as session:
                    await session.execute(text(sql))
        # deleting the campaign removes cards and state
        async with session_scope() as session:
            await session.execute(
                text(
                    "DELETE FROM ttrpg_campaigns WHERE id = '00000000-0000-0000-0000-0000000000c2'"
                )
            )
            for table in ("ttrpg_party_members", "ttrpg_party_state"):
                assert (await session.execute(text(f"SELECT count(*) FROM {table}"))).scalar() == 0
            await session.execute(
                text(
                    "INSERT INTO ttrpg_campaigns (id, user_id, title, folder) VALUES "
                    "('00000000-0000-0000-0000-0000000000c2', "
                    "'00000000-0000-0000-0000-0000000000a2', 'C', 'F2')"
                )
            )
        downgrade("f2c8b4d6e1a3")
        async with session_scope() as session:
            count = (await session.execute(text("SELECT count(*) FROM ttrpg_campaigns"))).scalar()
            assert count == 1
    finally:
        upgrade("head")
        async with session_scope() as session:
            await session.execute(text("DELETE FROM users WHERE email = 'p@example.com'"))


async def test_creature_table_constraints_and_the_unique_srd_import() -> None:
    downgrade("a4e0d6f8b3c5")
    try:
        async with session_scope() as session:
            await session.execute(
                text(
                    "INSERT INTO users (id, email, display_name, password_hash) VALUES "
                    "('00000000-0000-0000-0000-0000000000a3', 'c@example.com', 'C', 'x')"
                )
            )
        upgrade("head")
        user = "'00000000-0000-0000-0000-0000000000a3'"
        srd = (
            "INSERT INTO ttrpg_creatures (id, user_id, name, ac, hp, source, source_edition, "
            f"external_id) VALUES (gen_random_uuid(), {user}, 'Goblin', 15, 7, 'srd', '2014', "
            "'goblin')"
        )
        async with session_scope() as session:
            await session.execute(text(srd))
            await session.execute(
                text(
                    "INSERT INTO ttrpg_creatures (id, user_id, name, ac, hp) VALUES "
                    f"(gen_random_uuid(), {user}, 'Mine', 10, 5)"
                )
            )
        for sql in (
            srd,  # the same SRD creature twice for one owner
            "INSERT INTO ttrpg_creatures (id, user_id, name, ac, hp, source) VALUES "
            f"(gen_random_uuid(), {user}, 'x', 1, 1, 'srd')",  # srd without an external id
            "INSERT INTO ttrpg_creatures (id, user_id, name, ac, hp, external_id) VALUES "
            f"(gen_random_uuid(), {user}, 'x', 1, 1, 'e')",  # an external id on a manual card
            "INSERT INTO ttrpg_creatures (id, user_id, name, ac, hp) VALUES "
            f"(gen_random_uuid(), {user}, 'x', 1, 0)",
            "INSERT INTO ttrpg_creatures (id, user_id, name, ac, hp, source) VALUES "
            f"(gen_random_uuid(), {user}, 'x', 1, 1, 'wiki')",
        ):
            with pytest.raises(IntegrityError):
                async with session_scope() as session:
                    await session.execute(text(sql))
        # manual cards with the same name are fine
        async with session_scope() as session:
            await session.execute(
                text(
                    "INSERT INTO ttrpg_creatures (id, user_id, name, ac, hp) VALUES "
                    f"(gen_random_uuid(), {user}, 'Mine', 10, 5)"
                )
            )
        downgrade("a4e0d6f8b3c5")
        async with session_scope() as session:
            assert (await session.execute(text("SELECT count(*) FROM users"))).scalar() == 1
    finally:
        upgrade("head")
        async with session_scope() as session:
            await session.execute(text("DELETE FROM users WHERE email = 'c@example.com'"))


async def test_encounter_tables_constraints_cascade_and_set_null() -> None:
    downgrade("b5f1e7a9c4d6")
    try:
        async with session_scope() as session:
            await session.execute(
                text(
                    "INSERT INTO users (id, email, display_name, password_hash) VALUES "
                    "('00000000-0000-0000-0000-0000000000a4', 'e@example.com', 'E', 'x')"
                )
            )
            await session.execute(
                text(
                    "INSERT INTO ttrpg_campaigns (id, user_id, title, folder) VALUES "
                    "('00000000-0000-0000-0000-0000000000c4', "
                    "'00000000-0000-0000-0000-0000000000a4', 'C', 'F4')"
                )
            )
        upgrade("head")
        user = "'00000000-0000-0000-0000-0000000000a4'"
        enc = "'00000000-0000-0000-0000-0000000000e1'"
        async with session_scope() as session:
            await session.execute(
                text(
                    "INSERT INTO ttrpg_encounters (id, campaign_id, user_id, title) VALUES "
                    f"({enc}, '00000000-0000-0000-0000-0000000000c4', {user}, 'T')"
                )
            )
            await session.execute(
                text(
                    "INSERT INTO ttrpg_creatures (id, user_id, name, ac, hp) VALUES "
                    f"('00000000-0000-0000-0000-0000000000f1', {user}, 'G', 10, 5)"
                )
            )
            await session.execute(
                text(
                    "INSERT INTO ttrpg_encounter_slots (id, encounter_id, user_id, position, "
                    "creature_id, name, ac, hp) VALUES (gen_random_uuid(), "
                    f"{enc}, {user}, 1, '00000000-0000-0000-0000-0000000000f1', 'G1', 10, 5)"
                )
            )
        slot = (
            "INSERT INTO ttrpg_encounter_slots (id, encounter_id, user_id, position, name, ac, hp"
            f"{{extra}}) VALUES (gen_random_uuid(), {enc}, {user}, {{pos}}, 'x', 1, 1{{more}})"
        )
        for sql in (
            slot.format(extra="", pos=1, more=""),  # duplicate position
            slot.format(extra="", pos=2, more="").replace("1, 1)", "1, 0)"),  # hp 0
            slot.format(extra=", side", pos=3, more=", 'neutral'"),
        ):
            with pytest.raises(IntegrityError):
                async with session_scope() as session:
                    await session.execute(text(sql))
        async with session_scope() as session:
            await session.execute(
                text(
                    "DELETE FROM ttrpg_creatures WHERE id = '00000000-0000-0000-0000-0000000000f1'"
                )
            )
            creature = (
                await session.execute(text("SELECT creature_id FROM ttrpg_encounter_slots"))
            ).scalar()
            assert creature is None  # the slot keeps its copied stats
            await session.execute(text(f"DELETE FROM ttrpg_encounters WHERE id = {enc}"))
            count = (
                await session.execute(text("SELECT count(*) FROM ttrpg_encounter_slots"))
            ).scalar()
            assert count == 0
        downgrade("b5f1e7a9c4d6")
        async with session_scope() as session:
            assert (
                await session.execute(text("SELECT count(*) FROM ttrpg_campaigns"))
            ).scalar() == 1
    finally:
        upgrade("head")
        async with session_scope() as session:
            await session.execute(text("DELETE FROM users WHERE email = 'e@example.com'"))


async def test_combat_tables_allow_one_unfinished_run_per_campaign() -> None:
    downgrade("c6a2f8b0d5e7")
    try:
        async with session_scope() as session:
            await session.execute(
                text(
                    "INSERT INTO users (id, email, display_name, password_hash) VALUES "
                    "('00000000-0000-0000-0000-0000000000a5', 'r@example.com', 'R', 'x')"
                )
            )
            await session.execute(
                text(
                    "INSERT INTO ttrpg_campaigns (id, user_id, title, folder) VALUES "
                    "('00000000-0000-0000-0000-0000000000c5', "
                    "'00000000-0000-0000-0000-0000000000a5', 'C', 'F5')"
                )
            )
        upgrade("head")
        user = "'00000000-0000-0000-0000-0000000000a5'"
        camp = "'00000000-0000-0000-0000-0000000000c5'"

        def run(status: str) -> str:
            return (
                "INSERT INTO ttrpg_combat_runs (id, campaign_id, user_id, title, status) VALUES "
                f"(gen_random_uuid(), {camp}, {user}, 'T', '{status}')"
            )

        async with session_scope() as session:
            await session.execute(text(run("ended")))
            await session.execute(text(run("ended")))  # any number of finished fights
            await session.execute(text(run("paused")))
        for sql in (run("setup"), run("active"), run("bogus")):
            with pytest.raises(IntegrityError):
                async with session_scope() as session:
                    await session.execute(text(sql))
        async with session_scope() as session:  # finishing the unfinished one frees the slot
            await session.execute(text("UPDATE ttrpg_combat_runs SET status = 'ended'"))
            await session.execute(text(run("active")))
            rid = (
                await session.execute(
                    text("SELECT id FROM ttrpg_combat_runs WHERE status = 'active'")
                )
            ).scalar()
            comb = (
                "INSERT INTO ttrpg_combatants (id, run_id, user_id, kind, side, name, ac, max_hp, "
                f"position{{extra}}) VALUES (gen_random_uuid(), '{rid}', {user}, {{kind}}, "
                "'enemy', "
                "'g', 10, 5, 0{more})"
            )
            await session.execute(text(comb.format(extra=", hp", kind="'npc'", more=", 5")))
        for sql in (
            comb.format(extra="", kind="'npc'", more=""),  # an npc must own hp
            comb.format(extra=", hp", kind="'party'", more=", 5"),  # a party slot must not
            comb.format(extra=", hp", kind="'boss'", more=", 5"),
        ):
            with pytest.raises(IntegrityError):
                async with session_scope() as session:
                    await session.execute(text(sql))
        async with session_scope() as session:
            await session.execute(
                text(
                    "INSERT INTO ttrpg_combat_actions (id, run_id, user_id, seq, kind, "
                    f"mutation_key, request_hash, summary) VALUES (gen_random_uuid(), '{rid}', "
                    f"{user}, 1, 'damage', 'k1', 'h', 's')"
                )
            )
        for key_, seq in (("k1", 2), ("k2", 1)):  # duplicate key, duplicate sequence
            with pytest.raises(IntegrityError):
                async with session_scope() as session:
                    await session.execute(
                        text(
                            "INSERT INTO ttrpg_combat_actions (id, run_id, user_id, seq, kind, "
                            "mutation_key, request_hash, summary) VALUES (gen_random_uuid(), "
                            f"'{rid}', {user}, {seq}, 'damage', '{key_}', 'h', 's')"
                        )
                    )
        async with session_scope() as session:  # deleting the campaign removes everything
            await session.execute(text(f"DELETE FROM ttrpg_campaigns WHERE id = {camp}"))
            for table in ("ttrpg_combat_runs", "ttrpg_combatants", "ttrpg_combat_actions"):
                assert (await session.execute(text(f"SELECT count(*) FROM {table}"))).scalar() == 0
            await session.execute(
                text(
                    "INSERT INTO ttrpg_campaigns (id, user_id, title, folder) VALUES "
                    f"({camp}, {user}, 'C', 'F5')"
                )
            )
        downgrade("c6a2f8b0d5e7")
        async with session_scope() as session:
            assert (
                await session.execute(text("SELECT count(*) FROM ttrpg_campaigns"))
            ).scalar() == 1
    finally:
        upgrade("head")
        async with session_scope() as session:
            await session.execute(text("DELETE FROM users WHERE email = 'r@example.com'"))
