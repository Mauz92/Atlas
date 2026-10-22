"""Task priority ordering (M3-04): pure logic, no database."""

from __future__ import annotations

import pytest

from atlas.tasks.priority import PRIORITY_ORDER, UnknownPriorityError, priority_rank


def test_order_is_low_to_high() -> None:
    assert PRIORITY_ORDER == ("none", "low", "medium", "high", "urgent")


def test_rank_increases_with_urgency() -> None:
    assert [priority_rank(value) for value in PRIORITY_ORDER] == [0, 1, 2, 3, 4]


def test_sorting_by_rank_puts_the_most_urgent_first() -> None:
    values = ["low", "urgent", "none", "high", "medium"]
    assert sorted(values, key=priority_rank, reverse=True) == [
        "urgent",
        "high",
        "medium",
        "low",
        "none",
    ]


def test_unknown_priority_is_rejected() -> None:
    with pytest.raises(UnknownPriorityError):
        priority_rank("someday")
