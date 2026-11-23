"""Turn order, rounds, ties and removal of the active seat (TTRPG-06). Pure logic, no database."""

from __future__ import annotations

import uuid

from atlas.ttrpg.combat import (
    Seat,
    advance,
    initial_order,
    insertion_index,
    tie_groups,
)


def ids(n: int) -> list[uuid.UUID]:
    return [uuid.UUID(int=i + 1) for i in range(n)]


def seats(n: int, ineligible: tuple[int, ...] = ()) -> list[Seat]:
    return [Seat(seat_id, i, i not in ineligible) for i, seat_id in enumerate(ids(n))]


def test_the_first_advance_starts_round_one_with_the_first_eligible_seat() -> None:
    a, b, c = ids(3)
    turn = advance(seats(3, ineligible=(0,)), None, 0)
    assert (turn.active, turn.round) == (b, 1)
    assert advance(seats(3), None, 0).active == a
    assert c


def test_advancing_walks_the_order_and_wraps_into_a_new_round() -> None:
    a, b, c = ids(3)
    order = seats(3)
    assert [advance(order, a, 1).active, advance(order, b, 1).active] == [b, c]
    wrapped = advance(order, c, 1)
    assert (wrapped.active, wrapped.round) == (a, 2)
    again = advance(order, c, 7)
    assert (again.active, again.round) == (a, 8)


def test_defeated_and_removed_seats_are_skipped_but_a_party_member_at_zero_hp_is_not() -> None:
    a, b, c, d = ids(4)
    order = seats(4, ineligible=(1, 2))  # b and c are defeated or removed
    assert advance(order, a, 1).active == d
    wrapped = advance(order, d, 1)
    assert (wrapped.active, wrapped.round) == (a, 2)
    # eligibility is the caller's flag: a party member at 0 HP is simply passed as eligible
    assert advance(seats(4), a, 1).active == b
    assert c


def test_with_one_eligible_seat_every_advance_is_a_new_round() -> None:
    (only, *_rest) = ids(3)
    order = seats(3, ineligible=(1, 2))
    turn = advance(order, only, 1)
    assert (turn.active, turn.round) == (only, 2)


def test_nobody_eligible_is_a_clear_end_state() -> None:
    turn = advance(seats(3, ineligible=(0, 1, 2)), ids(3)[0], 4)
    assert turn.no_eligible is True and turn.active is None and turn.round == 4
    assert advance([], None, 0).no_eligible is True


def test_removing_the_active_seat_gives_the_next_eligible_one_and_may_wrap() -> None:
    a, b, c = ids(3)
    # b is active and gets removed: it is now ineligible, and its turn passes to c
    order = seats(3, ineligible=(1,))
    assert advance(order, b, 2).active == c and advance(order, b, 2).round == 2
    # the last seat removed while active: the turn wraps into the next round
    last = seats(3, ineligible=(2,))
    turn = advance(last, c, 2)
    assert (turn.active, turn.round) == (a, 3)
    assert b


def test_an_unknown_current_seat_restarts_the_round_instead_of_guessing() -> None:
    turn = advance(seats(3), uuid.uuid4(), 2)
    assert (turn.active, turn.round) == (ids(3)[0], 3)


def test_seats_are_ordered_by_order_index_not_by_list_position() -> None:
    a, b, c = ids(3)
    shuffled = [Seat(c, 2, True), Seat(a, 0, True), Seat(b, 1, True)]
    assert advance(shuffled, a, 1).active == b


def test_initial_order_handles_zero_and_negative_totals_and_ties() -> None:
    a, b, c, d = ids(4)
    totals = {a: 12, b: 0, c: -2, d: 12}
    positions = {a: 0, b: 1, c: 2, d: 3}
    assert initial_order(totals, positions) == [a, d, b, c]  # tie by roster position
    assert initial_order(totals, positions, tie_order=[d, a]) == [d, a, b, c]  # the DM's choice
    assert initial_order(totals, positions, tie_order=[b]) == [a, d, b, c]  # irrelevant entries
    assert tie_groups(totals) == [[a, d]]
    assert tie_groups({a: 1, b: 2}) == []


def test_reinforcements_join_after_everyone_who_rolled_higher_or_equal() -> None:
    a, b, c = ids(3)
    order = [(a, 18), (b, 12), (c, 5)]
    assert insertion_index(order, 20) == 0
    assert insertion_index(order, 12) == 2  # after its tie
    assert insertion_index(order, 6) == 2
    assert insertion_index(order, -1) == 3
    assert insertion_index([], 10) == 0
    assert insertion_index([(a, None), (b, 5)], 5) == 2
