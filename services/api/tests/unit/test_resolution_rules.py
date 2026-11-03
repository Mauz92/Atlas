"""The pure rules of the resolution log (SYNC-05): undoability, bounds and the paging cursor."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

import pytest

from atlas.sync.fields import plan_merge
from atlas.sync.resolution_rules import (
    MAX_DETAIL_CHARS,
    MAX_LOSER_BYTES,
    RULES,
    InvalidResolutionCursorError,
    bounded_detail,
    bounded_loser,
    decode_cursor,
    encode_cursor,
    parse_limit,
    undo_status,
)

ENTITY = uuid.uuid4()


def status(rule: str, **over):
    args = {
        "rule": rule,
        "entity_type": "task",
        "entity_id": ENTITY,
        "kept_revision": 4,
        "field": "priority",
        "has_loser": True,
        "undone": False,
        **over,
    }
    return undo_status(**args)


def test_only_the_two_later_wins_rules_are_undoable() -> None:
    assert {rule for rule in RULES if status(rule).undoable} == {
        "simple_later_wins",
        "path_later_wins",
    }


def test_every_other_rule_says_why_and_what_to_do() -> None:
    merged = status("note_merged", entity_type="note", field=None, has_loser=False)
    assert not merged.undoable and merged.reason == "rule_not_undoable"
    assert merged.follow_up is not None and merged.follow_up.kind == "note_history"
    assert merged.follow_up.href == f"/api/notes/{ENTITY}/history/4"
    revived = status("edit_wins_over_delete", field=None, has_loser=False)
    assert revived.follow_up is not None and revived.follow_up.kind == "delete_again"
    collided = status("path_collision", entity_type="note", field=None, has_loser=False)
    assert collided.follow_up is not None and collided.follow_up.kind == "rename"
    assert status("undo").reason == "is_undo"
    assert status("note_merged", kept_revision=None).follow_up.href is None  # type: ignore[union-attr]


def test_an_undone_or_valueless_entry_is_not_undoable() -> None:
    assert status("simple_later_wins", undone=True).reason == "already_undone"
    assert status("simple_later_wins", has_loser=False).reason == "value_not_stored"
    assert status("simple_later_wins", field=None).reason == "value_not_stored"


def test_the_stored_value_is_bounded() -> None:
    assert bounded_loser("low") == ("low", True)
    assert bounded_loser(None) == (None, True), "a null value is still a stored value"
    assert bounded_loser(["a", "b"]) == (["a", "b"], True)
    assert bounded_loser({"datetime": datetime(2031, 1, 1, tzinfo=UTC)})[1] is True
    assert bounded_loser("x" * (MAX_LOSER_BYTES + 1)) == (None, False)
    assert bounded_loser(object())[1] is True, "unknown objects are stringified, never raised"
    assert len(bounded_detail("é" * 5000) or "") == MAX_DETAIL_CHARS
    assert bounded_detail(None) is None


def test_the_cursor_round_trips_and_rejects_garbage() -> None:
    stamp, ident = datetime(2031, 5, 6, 7, 8, 9, 123456, tzinfo=UTC), uuid.uuid4()
    assert decode_cursor(encode_cursor(stamp, 2, ident)) == (stamp, 2, ident)
    for bad in ("", "***", "bm90LWEtY3Vyc29y", encode_cursor(stamp, 2, ident)[:-9]):
        with pytest.raises(InvalidResolutionCursorError):
            decode_cursor(bad)


def test_limits() -> None:
    assert parse_limit(None) == 50 and parse_limit(1) == 1 and parse_limit(200) == 200
    for bad in (0, 201, -1):
        with pytest.raises(ValueError):
            parse_limit(bad)


def test_strict_merge_turns_every_concurrent_change_into_a_conflict() -> None:
    common = {
        "incoming": {"priority": "low", "title": "t"},
        "stored": {"priority": "high", "title": "other"},
        "field_revisions": {"priority": 5, "title": 5},
        "base_revision": 4,
        "revision": 5,
        "text_fields": frozenset({"title"}),
    }
    lenient = plan_merge(**common)
    assert lenient.apply == {"priority": "low"} and len(lenient.resolutions) == 1
    strict = plan_merge(**common, strict=True)
    assert strict.apply == {} and strict.resolutions == []
    assert {(c.field, c.reason) for c in strict.conflicts} == {
        ("priority", "changed_since"),
        ("title", "changed_since"),
    }
    # nothing changed since the base: strict applies it like any write
    quiet = plan_merge(**{**common, "field_revisions": {"priority": 4, "title": 4}}, strict=True)
    assert quiet.apply == {"priority": "low", "title": "t"}
