"""The resolution simulation against the real API (SYNC-05).

The same clients, fault-injecting network and invariants as ``test_sim_resolutions_model.py``, with
every request that survives the network executed by the real application on PostgreSQL and a
per-test notes folder. A run takes a few seconds, so the default is a handful of seeds;
``ATLAS_SIM_REAL_SEEDS`` raises it (the soak recorded in ACCEPTANCE.md used 20).

Invariants that need the model's private ground truth (every generated resolution has a row, the
field revision under an undo) are model-only; against the real API the harness judges what a
client can observe: the exact set of resolutions it was told about equals the log, exactly one undo
entry per undone resolution, the value an undo replaced equals the value the winning write stored,
no text in the log, and every client holds exactly the log through the feed.
"""

from __future__ import annotations

import os

import pytest
from httpx import AsyncClient

from tests.conftest import create_user_via_setup

from .engine import SimConfig, env_int
from .real import RealServer
from .runner import run_world

REAL_SEEDS = env_int("ATLAS_SIM_REAL_SEEDS", 3)
STEPS = env_int("ATLAS_SIM_STEPS", 70)
ONE = os.environ.get("ATLAS_SIM_SEED")

pytestmark = pytest.mark.usefixtures("_db")


@pytest.mark.parametrize("seed", [int(ONE)] if ONE else list(range(REAL_SEEDS)))
async def test_resolution_clients_converge_on_the_real_api(
    notes_client: AsyncClient, seed: int
) -> None:
    await create_user_via_setup(notes_client)
    cfg = SimConfig(
        steps=STEPS,
        clients=3,
        sync=True,
        resolutions=True,
        kinds=("task", "project", "note"),
        late_joiner=True,
        action_p=0.5,
        undo_rounds=25,
    )
    world = await run_world(seed, RealServer(notes_client), cfg)
    assert world.net.sent > 0
