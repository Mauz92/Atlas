"""The simulation on the in-memory model server (SYNC-02, layer B of TESTING.md section 10).

Seeds are cheap (milliseconds). Default 100 seeds; ``ATLAS_SIM_SEEDS`` raises it for a soak run and
``ATLAS_SIM_SEED=<n>`` re-runs exactly one seed (what a failure message tells you to do).
"""

from __future__ import annotations

import os

import pytest

from .engine import SimConfig, env_int
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
