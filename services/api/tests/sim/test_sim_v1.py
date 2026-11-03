"""The simulation for protocol v1 (SYNC-03): client ids, field merge, edit wins, snapshot bootstrap,
``include=data`` pulls and the old-client ``426``. Model server here, real API at the bottom.

Defaults: 100 model seeds, 3 real seeds; ``ATLAS_SIM_SEEDS`` / ``ATLAS_SIM_REAL_SEEDS`` /
``ATLAS_SIM_STEPS`` for a soak, ``ATLAS_SIM_SEED=<n>`` to re-run one failing seed.
"""

from __future__ import annotations

import os

import pytest
from httpx import AsyncClient

from tests.conftest import create_user_via_setup

from .client import ClientBugs
from .engine import SimConfig, SimFailure, env_int
from .model import ModelServer, ServerBugs
from .real import RealServer
from .runner import canonical, run_world

SEEDS = env_int("ATLAS_SIM_SEEDS", 100)
REAL_SEEDS = env_int("ATLAS_SIM_REAL_SEEDS", 3)
STEPS = env_int("ATLAS_SIM_STEPS", 120)
ONE = os.environ.get("ATLAS_SIM_SEED")


def _seeds(count: int = SEEDS) -> list[int]:
    return [int(ONE)] if ONE else list(range(count))


def _cfg(**kw: object) -> SimConfig:
    return SimConfig(steps=STEPS, sync=True, **kw)  # type: ignore[arg-type]


@pytest.mark.parametrize("seed", _seeds())
async def test_sync_clients_converge_under_faults(seed: int) -> None:
    await run_world(seed, ModelServer(), _cfg())


@pytest.mark.parametrize("seed", _seeds(60))
async def test_a_client_that_joins_late_bootstraps_from_the_snapshot(seed: int) -> None:
    world = await run_world(seed, ModelServer(), _cfg(late_joiner=True, clients=4))
    assert any("JOINS" in line for line in world.trace)


@pytest.mark.parametrize("seed", _seeds(60))
async def test_clients_converge_when_tombstones_are_purged(seed: int) -> None:
    """Retention drops tombstones (never upserts); a client below the floor re-walks a snapshot."""
    cfg = _cfg(p_purge=0.05, clients=4)
    world = await run_world(seed, ModelServer(), cfg)
    assert world.net.sent > 0


@pytest.mark.parametrize("seed", _seeds(40))
async def test_an_unsupported_client_is_refused_and_stops(seed: int) -> None:
    world = await run_world(seed, ModelServer(), _cfg(old_client=True))
    assert any("426" in line for line in world.trace)


@pytest.mark.parametrize("seed", _seeds(40))
async def test_final_state_does_not_depend_on_client_clocks_in_sync_mode(seed: int) -> None:
    skewed = await run_world(seed, ModelServer(), _cfg(skew=True))
    straight = await run_world(seed, ModelServer(), _cfg(skew=False))
    assert canonical(skewed) == canonical(straight), (
        f"seed={seed}: client clocks changed the outcome"
    )


async def test_the_runs_exercise_every_merge_outcome() -> None:
    """The runs must actually hit conflicts, edit-wins and revives, or the seeds prove little."""
    seen = {"conflict": 0, "edit_wins": 0, "later_wins": 0, "revive": 0, "stale": 0}
    for seed in range(40):
        server = ModelServer()
        world = await run_world(seed, server, _cfg())
        for _cid, _op, _status, code in world.rec.refusals:
            seen[code or "none"] = seen.get(code or "none", 0) + 1
        seen["revive"] += sum(1 for e in server.history if e.event == "revive")
        seen["later_wins"] += sum(
            1
            for _c, _o, _s, b in world.rec.acks
            if isinstance(b, dict)
            and any(
                r["rule"] == "simple_later_wins"
                for r in (b.get("sync") or {}).get("resolution", [])
            )
        )
    assert seen["conflict"] > 0 and seen["edit_wins"] > 0, seen
    assert seen["revive"] > 0 and seen["later_wins"] > 0, seen
    assert seen["stale"] == 0, seen


# --- the harness can fail: one planted defect per protocol v1 invariant --------------------------

_CASES = [
    (
        "sync merge ignores field revisions",
        ServerBugs(merge_ignores_field_revisions=True),
        None,
        {"no_silent_text_loss"},
    ),
    (
        "a stale delete wins over a newer edit",
        ServerBugs(stale_delete_wins=True),
        None,
        {"edit_wins"},
    ),
    (
        "an edit of a deleted entity is 404",
        ServerBugs(no_revive=True),
        None,
        {"unexpected_rejection"},
    ),
    (
        "the snapshot omits an entity",
        ServerBugs(snapshot_skips_entity=True),
        None,
        {"convergence", "cursor_safety"},
    ),
    (
        "the server accepts an unsupported protocol",
        ServerBugs(accepts_any_protocol=True),
        None,
        {"stop_on_426"},
    ),
    (
        "the client ignores 426",
        None,
        ClientBugs(ignore_426=True),
        {"stop_on_426", "bounded_work"},
    ),
    (
        "the client retries without its key",
        None,
        ClientBugs(regen_key_on_retry=True),
        {"no_duplicates"},
    ),
]


@pytest.mark.parametrize(
    ("name", "server_bugs", "client_bugs", "expected"), _CASES, ids=[c[0] for c in _CASES]
)
async def test_each_planted_defect_is_caught(
    name: str,
    server_bugs: ServerBugs | None,
    client_bugs: ClientBugs | None,
    expected: set[str],
) -> None:
    cfg = _cfg(late_joiner=True, old_client=True, clients=4, p_drop_response=0.15)
    failure: SimFailure | None = None
    for seed in range(300):
        try:
            await run_world(seed, ModelServer(server_bugs), cfg, client_bugs)
        except SimFailure as caught:
            failure = caught
            break
    assert failure is not None, f"{name}: no seed in 300 detected the planted defect"
    assert failure.invariant in expected, f"{name}: {failure}"
    assert f"seed={failure.seed}" in str(failure)
    with pytest.raises(SimFailure) as again:  # reproducible from the seed
        await run_world(failure.seed, ModelServer(server_bugs), cfg, client_bugs)
    assert again.value.invariant == failure.invariant
    await run_world(failure.seed, ModelServer(), cfg)  # and the seed passes without the defect


# --- the same clients against the real API ----------------------------------------------------


@pytest.mark.usefixtures("_db")
@pytest.mark.parametrize("seed", _seeds(REAL_SEEDS))
async def test_sync_clients_converge_on_the_real_api(client: AsyncClient, seed: int) -> None:
    await create_user_via_setup(client)
    cfg = SimConfig(
        steps=env_int("ATLAS_SIM_STEPS", 70),
        clients=3,
        sync=True,
        late_joiner=True,
        old_client=True,
    )
    world = await run_world(seed, RealServer(client), cfg)
    assert world.net.sent > 0
