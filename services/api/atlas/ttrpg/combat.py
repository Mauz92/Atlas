"""Turn order for a combat run: pure functions, no database (TTRPG-06).

The run's roster is a list of :class:`Seat` in **turn order** (``order_index`` ascending). A seat is
*eligible* for a turn unless it was removed or defeated. A party member at 0 HP is **not**
defeated: they stay in the order (death saves) until the DM removes them.

Rules, all covered by ``tests/unit/test_ttrpg_combat.py``:

* initiative totals may be zero or negative; higher acts first; ties are resolved by an explicit
  list the DM gives (then by the roster position they were added in), never at random;
* advancing moves to the next eligible seat; passing the end of the order starts a new round;
* removing (or defeating via an explicit end of turn) the active seat gives a stable next turn: the
  next eligible seat after it, wrapping into a new round when it passes the end;
* when nobody is eligible the run has a clear end state (``NO_ELIGIBLE``) instead of an arbitrary
  active seat.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable, Sequence
from dataclasses import dataclass


@dataclass(frozen=True)
class Seat:
    id: uuid.UUID
    order_index: int
    eligible: bool


@dataclass(frozen=True)
class Turn:
    """The outcome of moving to the next turn."""

    active: uuid.UUID | None
    round: int
    #: ``True`` when nobody is eligible (the run should end)
    no_eligible: bool = False


def advance(seats: Sequence[Seat], current: uuid.UUID | None, round_number: int) -> Turn:
    """The next eligible seat after ``current`` (or the first one when there is no current).

    ``round_number`` is the round in progress (0 when none has started). Wrapping past the end of
    the order, or finding only ``current`` itself, starts the next round.
    """
    ordered = sorted(seats, key=lambda seat: seat.order_index)
    eligible = [seat for seat in ordered if seat.eligible]
    if not eligible:
        return Turn(None, round_number, no_eligible=True)
    if current is None:
        return Turn(eligible[0].id, max(round_number, 1))
    position = next((seat.order_index for seat in ordered if seat.id == current), None)
    if position is None:
        # An unknown current seat: start from the top of a fresh round rather than guessing.
        return Turn(eligible[0].id, round_number + 1)
    after = [seat for seat in eligible if seat.order_index > position]
    if after:
        return Turn(after[0].id, max(round_number, 1))
    return Turn(eligible[0].id, max(round_number, 1) + 1)


def tie_groups(initiatives: dict[uuid.UUID, int]) -> list[list[uuid.UUID]]:
    """Groups of seats that share an initiative total (only groups of two or more)."""
    by_total: dict[int, list[uuid.UUID]] = {}
    for seat_id, total in initiatives.items():
        by_total.setdefault(total, []).append(seat_id)
    return [ids for _total, ids in sorted(by_total.items(), reverse=True) if len(ids) > 1]


def initial_order(
    initiatives: dict[uuid.UUID, int],
    positions: dict[uuid.UUID, int],
    tie_order: Sequence[uuid.UUID] = (),
) -> list[uuid.UUID]:
    """Seat ids in turn order: higher total first, ties by ``tie_order`` then by ``positions``."""
    rank = {seat_id: index for index, seat_id in enumerate(tie_order)}
    return sorted(
        initiatives,
        key=lambda seat_id: (
            -initiatives[seat_id],
            rank.get(seat_id, len(rank)),
            positions.get(seat_id, 0),
        ),
    )


def insertion_index(
    existing: Iterable[tuple[uuid.UUID, int | None]],
    initiative: int,
) -> int:
    """Where a reinforcement with ``initiative`` joins an order given as ``(id, total)`` pairs in
    turn order: after every seat that rolled higher or equal (it acts last among its ties)."""
    index = 0
    for position, (_seat_id, total) in enumerate(existing):
        if total is not None and total >= initiative:
            index = position + 1
    return index
