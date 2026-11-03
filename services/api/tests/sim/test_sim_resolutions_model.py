"""The resolution log and undo in the multi-client simulation (SYNC-05; TESTING.md section 10.0c).

The clients of ``client_v1`` also pull the ``resolution`` feed entity and undo the notices they see;
``runner._check_resolutions`` judges the run. This module runs the model server (default 100
seeds, ``ATLAS_SIM_SEEDS`` for a soak), the planted defects (one per invariant) and the restore
scenario. The same world against the real API is in ``test_sim_resolutions_real.py`` and the
model/real conformance traces in ``test_sim_resolutions.py``.
"""

from __future__ import annotations

import os

import pytest

from .engine import SimConfig, SimFailure, env_int
from .model import ModelServer, ServerBugs
from .runner import check_log_matches_state, fetch_log, run_world

SEEDS = env_int("ATLAS_SIM_SEEDS", 100)
#: longer than the other simulations: a notice must be learned before it can be undone
STEPS = env_int("ATLAS_SIM_STEPS", 250)
ONE = os.environ.get("ATLAS_SIM_SEED")


def _seeds(count: int = SEEDS) -> list[int]:
    return [int(ONE)] if ONE else list(range(count))


def _cfg(**kw: object) -> SimConfig:
    kw.setdefault("action_p", 0.5)
    return SimConfig(steps=STEPS, sync=True, resolutions=True, **kw)  # type: ignore[arg-type]


@pytest.mark.parametrize("seed", _seeds())
async def test_clients_converge_with_resolutions_and_undo(seed: int) -> None:
    await run_world(seed, ModelServer(), _cfg())


@pytest.mark.parametrize("seed", _seeds(40))
async def test_resolutions_survive_a_purge_a_late_joiner_and_notes(seed: int) -> None:
    cfg = _cfg(kinds=("task", "project", "note"), late_joiner=True, p_purge=0.05, clients=4)
    await run_world(seed, ModelServer(), cfg)


@pytest.mark.parametrize("seed", _seeds(40))
async def test_final_state_does_not_depend_on_client_clocks_with_resolutions(seed: int) -> None:
    from .runner import canonical

    skewed = await run_world(seed, ModelServer(), _cfg(skew=True))
    straight = await run_world(seed, ModelServer(), _cfg(skew=False))
    assert canonical(skewed) == canonical(straight), (
        f"seed={seed}: client clocks changed the outcome"
    )


async def test_the_runs_exercise_every_resolution_and_undo_outcome() -> None:
    """A green run proves little unless the seeds really hit every rule, applied undos, no-op undos
    and each refusal. This pins that they do."""
    rules: dict[str, int] = {}
    outcomes = {"applied": 0, "no_op": 0}
    refusals: dict[str, int] = {}
    for seed in range(60):
        world = await run_world(
            seed, ModelServer(), _cfg(kinds=("task", "project", "note"), clients=4)
        )
        for entry in await fetch_log(world):
            rules[entry["rule"]] = rules.get(entry["rule"], 0) + 1
        for _cid, _op, _status, body in world.rec.undos:
            outcomes["applied" if body["applied"] else "no_op"] += 1
        for _cid, _op, _status, code in world.rec.undo_refusals:
            refusals[str(code)] = refusals.get(str(code), 0) + 1
    for rule in (
        "simple_later_wins",
        "edit_wins_over_delete",
        "note_merged",
        "path_collision",
        "path_later_wins",
        "undo",
    ):
        assert rules.get(rule, 0) > 0, (rule, rules)
    assert outcomes["applied"] > 0, outcomes
    assert refusals.get("conflict", 0) > 0 and refusals.get("already_undone", 0) > 0, refusals


# --- the harness can fail: one planted defect per invariant ---------------------------------------

_CASES = [
    (
        "a resolution is reported but never written to the log",
        ServerBugs(res_not_logged=True),
        {"resolution_logged_once"},
    ),
    (
        "a replayed write logs its resolutions again",
        ServerBugs(res_logged_on_replay=True),
        {"resolution_logged_once"},
    ),
    (
        "a refused delete leaves a log entry although nothing was written",
        ServerBugs(res_logged_without_write=True),
        {"no_log_without_write", "resolution_logged_once"},
    ),
    (
        "an entry is logged but never announced on the feed",
        ServerBugs(res_not_announced=True),
        {"resolutions_converge"},
    ),
    (
        "a merged note keeps its content in the log",
        ServerBugs(res_keeps_text=True),
        {"log_has_no_text"},
    ),
    (
        "undo overwrites a value that changed after the resolution",
        ServerBugs(undo_ignores_newer_change=True),
        {"undo_never_overwrites_newer"},
    ),
    (
        "a resolution can be undone twice",
        ServerBugs(undo_twice=True),
        {"undo_once"},
    ),
    (
        "an undo is applied but not logged",
        ServerBugs(undo_not_logged=True),
        {"undo_logged"},
    ),
    (
        "an undo retried with its key is evaluated again",
        ServerBugs(undo_not_idempotent=True),
        {"undo_idempotent"},
    ),
    (
        "an undo brings a deleted entity back",
        ServerBugs(undo_revives_deleted=True),
        {"no_resurrection"},
    ),
]


@pytest.mark.parametrize(("name", "bugs", "expected"), _CASES, ids=[c[0] for c in _CASES])
async def test_each_planted_defect_is_caught(
    name: str, bugs: ServerBugs, expected: set[str]
) -> None:
    cfg = _cfg(kinds=("task", "project", "note"), clients=4, p_drop_response=0.15)
    failure: SimFailure | None = None
    for seed in range(300):
        try:
            await run_world(seed, ModelServer(bugs), cfg)
        except SimFailure as caught:
            failure = caught
            break
    assert failure is not None, f"{name}: no seed in 300 detected the planted defect"
    assert failure.invariant in expected, f"{name}: {failure}"
    assert f"seed={failure.seed}" in str(failure)
    with pytest.raises(SimFailure) as again:  # reproducible from the seed
        await run_world(failure.seed, ModelServer(bugs), cfg)
    assert again.value.invariant == failure.invariant
    await run_world(failure.seed, ModelServer(), cfg)  # and the seed passes without the defect


# --- a log survives a restore as part of the database ---------------------------------------------


async def _lww(model: ModelServer, task: str, key: str, n: int) -> str:
    """Two writers of one priority: the second wins and is logged; returns the entry id."""
    from .engine import Req

    sync = {"Atlas-Sync": "1"}
    base = (await model.handle(Req("GET", f"/api/tasks/{task}"))).body["revision"]
    for value, suffix in (("low", "a"), ("high", "b")):
        resp = await model.handle(
            Req(
                "PATCH",
                f"/api/tasks/{task}",
                body={"base_revision": base, "priority": value},
                headers={**sync, "Idempotency-Key": f"{key}-{n}-{suffix}"},
            )
        )
        assert resp.status == 200, resp
    return str(resp.body["sync"]["resolution"][0]["id"])


@pytest.mark.parametrize("bug", [False, True], ids=["log restored with the database", "planted"])
async def test_the_log_is_restored_with_the_database(bug: bool) -> None:
    from .engine import Req

    model = ModelServer(ServerBugs(restore_keeps_newer_log=bug))
    created = await model.handle(
        Req(
            "POST",
            "/api/tasks",
            body={"title": "t"},
            headers={"Atlas-Sync": "1", "Idempotency-Key": "k-0"},
        )
    )
    task = created.body["id"]
    first = await _lww(model, task, "k", 1)
    backup = model.snapshot()
    second = await _lww(model, task, "k", 2)  # after the backup
    assert [e["id"] for e in model.res_log] == [first, second]
    model.restore_from(backup)
    problem = check_log_matches_state(model)
    if bug:
        assert problem is not None and second in problem, problem
        return
    assert problem is None, problem
    assert [e["id"] for e in model.res_log] == [first]
    listing = await model.handle(Req("GET", "/api/sync/resolutions", headers={"Atlas-Sync": "1"}))
    assert [e["id"] for e in listing.body["resolutions"]] == [first]
    # the feed agrees: the entry's row is there, the one made after the backup is gone
    feed = await model.handle(
        Req("GET", "/api/changes", params={"types": "resolution"}, headers={"Atlas-Sync": "1"})
    )
    assert [c["entity_id"] for c in feed.body["changes"]] == [first]
    # and the restored entry can still be undone
    undone = await model.handle(
        Req(
            "POST",
            f"/api/sync/resolutions/{first}/undo",
            headers={"Atlas-Sync": "1", "Idempotency-Key": "k-undo"},
        )
    )
    assert undone.status == 200 and undone.body["applied"] is True
