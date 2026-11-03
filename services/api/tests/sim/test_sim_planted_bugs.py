"""Mutation checks of the harness itself (SYNC-02): every invariant must be able to fail.

Each case plants exactly one defect in the model server or the model client and asserts that some
seed in a small range makes the *named* invariant fail, that the failure message carries the seed,
that re-running that seed fails the same way (reproducibility) and that the very same seed passes
without the defect (so the failure is the defect's, not the harness's).
"""

from __future__ import annotations

import pytest

from .client import ClientBugs, Op
from .engine import Req, SimConfig, SimFailure
from .model import ModelServer, ServerBugs
from .runner import _check_invariants, _quiesce, build_world, canonical, run_world

_CFG = SimConfig(steps=150)


async def _first_failure(
    server_bugs: ServerBugs | None = None,
    client_bugs: ClientBugs | None = None,
    cfg: SimConfig = _CFG,
    seeds: range = range(300),
) -> SimFailure | None:
    for seed in seeds:
        try:
            await run_world(seed, ModelServer(server_bugs), cfg, client_bugs)
        except SimFailure as failure:
            return failure
    return None


# (id, server bugs, client bugs, accepted invariant names)
_CASES = [
    (
        "server ignores idempotency keys",
        ServerBugs(ignore_idempotency=True),
        None,
        {"no_duplicates"},
    ),
    (
        "server acknowledges a patch it dropped",
        ServerBugs(ack_but_drop_write=True),
        None,
        {"no_acknowledged_loss"},
    ),
    (
        "server orders by client time",
        ServerBugs(lww_by_client_time=True),
        None,
        {"no_acknowledged_loss"},
    ),
    (
        "server skips a feed row",
        ServerBugs(skip_feed_row=True),
        None,
        {"cursor_safety", "convergence"},
    ),
    (
        "server resurrects on a stale patch",
        ServerBugs(resurrect_on_stale_patch=True),
        None,
        {"no_resurrection"},
    ),
    (
        "feed cursor overshoots",
        ServerBugs(feed_cursor_skips=True),
        None,
        {"cursor_safety", "convergence"},
    ),
    (
        "cursor advanced before the page is applied",
        None,
        ClientBugs(advance_cursor_before_apply=True),
        {"cursor_safety"},
    ),
    (
        "retry without the original idempotency key",
        None,
        ClientBugs(regen_key_on_retry=True),
        {"no_duplicates", "idempotency_key_stability"},
    ),
    (
        "tombstones ignored",
        None,
        ClientBugs(ignore_tombstones=True),
        {"cursor_safety", "convergence"},
    ),
    (
        "queue ordered by the client clock",
        None,
        ClientBugs(queue_ordered_by_client_clock=True),
        {"bounded_work", "convergence", "no_acknowledged_loss"},
    ),
]


@pytest.mark.parametrize(
    ("server_bugs", "client_bugs", "expected"),
    [pytest.param(s, c, e, id=name) for name, s, c, e in _CASES],
)
async def test_a_planted_bug_is_caught_by_its_invariant(
    server_bugs: ServerBugs | None, client_bugs: ClientBugs | None, expected: set[str]
) -> None:
    failure = await _first_failure(server_bugs, client_bugs)
    assert failure is not None, "the planted bug went undetected in 300 seeds: the harness is blind"
    assert failure.invariant in expected, (
        f"caught by '{failure.invariant}', expected one of {expected}"
    )
    assert f"seed={failure.seed}" in str(failure)

    with pytest.raises(SimFailure) as again:  # reproducible from the seed alone
        await run_world(failure.seed, ModelServer(server_bugs), _CFG, client_bugs)
    assert again.value.invariant == failure.invariant

    await run_world(failure.seed, ModelServer(), _CFG, None)  # same seed, defect removed: passes


async def test_client_clock_dependence_changes_the_outcome() -> None:
    """Invariant 6 can fail: a server that lets client time decide is clock-dependent."""
    bugs = ServerBugs(lww_by_client_time=True)
    for seed in range(300):
        skewed = await run_world(
            seed, ModelServer(bugs), SimConfig(steps=150, skew=True), invariants=False
        )
        straight = await run_world(
            seed, ModelServer(bugs), SimConfig(steps=150, skew=False), invariants=False
        )
        if canonical(skewed) != canonical(straight):
            return
    pytest.fail("no seed showed the planted clock dependence in the final state")


# The convergence invariant on its own (the model-only per-row cursor check switched off): a
# silently lost feed row or an ignored tombstone must still leave a client unlike the server.
@pytest.mark.parametrize(
    ("server_bugs", "client_bugs"),
    [
        pytest.param(ServerBugs(skip_feed_row=True), None, id="server skips a feed row"),
        pytest.param(None, ClientBugs(ignore_tombstones=True), id="tombstones ignored"),
    ],
)
async def test_convergence_alone_detects_a_lost_change(
    server_bugs: ServerBugs | None, client_bugs: ClientBugs | None
) -> None:
    cfg = SimConfig(steps=150, check_cursor_rows=False)
    failure = await _first_failure(server_bugs, client_bugs, cfg)
    assert failure is not None and failure.invariant == "convergence"


@pytest.mark.parametrize(
    ("buggy", "rows", "expected"),
    [(False, True, None), (True, True, "cursor_safety"), (True, False, "convergence")],
    ids=["correct client", "stale apply, per-row check on", "stale apply, convergence alone"],
)
async def test_applying_a_stale_replayed_acknowledgement_is_detected(
    buggy: bool, rows: bool, expected: str | None
) -> None:
    """A lost response is replayed after a newer revision was pulled; applying it regresses.

    Scripted rather than searched for: the interleaving is too rare for random seeds to be a
    reliable check (200 random seeds of a hostile configuration never produced it).
    """
    server = ModelServer()
    world = build_world(
        0,
        server,
        SimConfig(skew=False, check_cursor_rows=rows),
        ClientBugs(apply_stale_revisions=buggy),
    )
    world.net.faults = False
    c1 = world.clients[0]
    c1.durable.queue.append(
        Op(
            "c1-1",
            "task",
            "create",
            "h:c1-1",
            {"title": "t", "description": None},
            False,
            "key-create",
            0,
        )
    )
    await _quiesce(world)  # everybody holds e1 at revision 1

    mine = Op("c1-9", "task", "patch", "e1", {"description": "mine"}, False, "key-mine", 0)
    first = await server.handle(
        Req(
            "PATCH",
            "/api/tasks/e1",
            body=mine.fields,
            headers={"Idempotency-Key": "key-mine", "X-Sim-Op": "c1-9"},
        )
    )  # applied (revision 2); its response never reaches c1
    assert first.body["revision"] == 2
    await server.handle(Req("PATCH", "/api/tasks/e1", body={"description": "theirs"}))  # revision 3
    c1.durable.queue.append(mine)
    c1.next_pull_at = (
        0  # c1 pulls (revision 3) before it retries; the retry is replayed (revision 2)
    )

    if buggy:
        with pytest.raises(SimFailure) as failure:
            await _quiesce(world)
            await _check_invariants(world)
        assert failure.value.invariant == expected
        assert "c1" in str(failure.value)
    else:
        await _quiesce(world)
        await _check_invariants(world)
        assert c1.durable.mirror["e1"].revision == 3
