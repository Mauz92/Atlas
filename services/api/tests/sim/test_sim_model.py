"""The simulation on the in-memory model server (SYNC-02, layer B of TESTING.md section 10).

Seeds are cheap (milliseconds). Default 100 seeds; ``ATLAS_SIM_SEEDS`` raises it for a soak run and
``ATLAS_SIM_SEED=<n>`` re-runs exactly one seed (what a failure message tells you to do).
"""

from __future__ import annotations

import os

import pytest

from .client import ClientBugs
from .engine import SimConfig, SimFailure, env_int
from .model import ModelServer
from .runner import canonical, run_world

SEEDS = env_int("ATLAS_SIM_SEEDS", 100)
STEPS = env_int("ATLAS_SIM_STEPS", 120)
ONE = os.environ.get("ATLAS_SIM_SEED")


def _seeds() -> list[int]:
    return [int(ONE)] if ONE else list(range(SEEDS))


@pytest.mark.parametrize("seed", _seeds())
async def test_clients_converge_under_faults(seed: int) -> None:
    await run_world(seed, ModelServer(), SimConfig(steps=STEPS))


@pytest.mark.parametrize("seed", _seeds()[:40])
async def test_clients_converge_when_the_feed_is_purged(seed: int) -> None:
    """Retention purges force resyncs (below_floor); the clients must still converge."""
    world = await run_world(seed, ModelServer(), SimConfig(steps=STEPS, p_purge=0.04, clients=4))
    assert world.net.sent > 0


@pytest.mark.parametrize("seed", _seeds()[:40])
async def test_final_state_does_not_depend_on_client_clocks(seed: int) -> None:
    """Invariant 6: the same schedule with different (jumping) clock skew ends in the same state."""
    skewed = await run_world(seed, ModelServer(), SimConfig(steps=STEPS, skew=True))
    straight = await run_world(seed, ModelServer(), SimConfig(steps=STEPS, skew=False))
    assert canonical(skewed) == canonical(straight), (
        f"seed={seed}: client clocks changed the outcome"
    )


async def test_a_run_is_reproducible_from_its_seed() -> None:
    first = await run_world(7, ModelServer(), SimConfig())
    second = await run_world(7, ModelServer(), SimConfig())
    assert first.trace == second.trace
    assert canonical(first) == canonical(second)
    other = await run_world(8, ModelServer(), SimConfig())
    assert other.trace != first.trace


# --- named regression cases ----------------------------------------------------------------


async def test_regression_seed_482_a_replayed_create_must_not_resurrect_a_deleted_project() -> None:
    """Found by the 2000-seed/300-step soak (SYNC-03 pre-work); root cause was in the model client.

    c1's ``POST /api/projects`` is applied but its response is lost; c2 then deletes the project
    and c1 pulls past that tombstone; c1's retry (same idempotency key) is answered with the
    *original* ``201`` body (revision 1). Installing that body as current state left c1 holding a
    live project that the server had deleted, with the delete's feed row already below c1's
    cursor, so nothing would ever correct it. An acknowledgement is historical: it may only fill a
    gap, and the entity is read again at the next pull. The old behaviour is kept behind
    ``ClientBugs.trust_ack_state`` so this test also proves the case can fail.
    """
    cfg = SimConfig(steps=300)
    with pytest.raises(SimFailure) as failure:
        await run_world(482, ModelServer(), cfg, ClientBugs(trust_ack_state=True))
    assert failure.value.invariant == "cursor_safety"
    assert "delete project" in str(failure.value)
    await run_world(482, ModelServer(), cfg)


@pytest.mark.parametrize("seed", range(300))
async def test_long_runs_converge(seed: int) -> None:
    """Fixed seeds at 300 steps (the soak shape) so a regression there fails the normal run."""
    await run_world(seed, ModelServer(), SimConfig(steps=300))
