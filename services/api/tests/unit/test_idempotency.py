"""Idempotency helpers (M3-02): pure logic, no database."""

from __future__ import annotations

import pytest

from atlas.idempotency import IdempotencyConflictError, fingerprint, is_replay


def test_fingerprint_is_independent_of_key_order() -> None:
    assert fingerprint({"a": 1, "b": 2}) == fingerprint({"b": 2, "a": 1})


def test_fingerprint_changes_with_the_payload() -> None:
    assert fingerprint({"title": "first"}) != fingerprint({"title": "second"})


def test_fingerprint_treats_none_and_empty_alike() -> None:
    assert fingerprint(None) == fingerprint({})


def test_fingerprint_is_stable_and_hex() -> None:
    digest = fingerprint({"x": 1})
    assert digest == fingerprint({"x": 1})
    assert len(digest) == 64
    int(digest, 16)  # raises if not hexadecimal


def test_is_replay_accepts_the_same_request() -> None:
    assert (
        is_replay("task.create", "abc", operation="task.create", request_fingerprint="abc") is True
    )


def test_is_replay_rejects_a_different_payload() -> None:
    with pytest.raises(IdempotencyConflictError):
        is_replay("task.create", "abc", operation="task.create", request_fingerprint="def")


def test_is_replay_rejects_a_different_operation() -> None:
    with pytest.raises(IdempotencyConflictError):
        is_replay("task.create", "abc", operation="task.update", request_fingerprint="abc")
