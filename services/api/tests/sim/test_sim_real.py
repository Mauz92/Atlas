"""The simulation against the real API (SYNC-02, layer C of TESTING.md section 10).

The same clients, fault-injecting network and invariants as ``test_sim_model.py``, but every request
that survives the network is executed by the real FastAPI application on PostgreSQL. A run needs a
few seconds, so the default is a handful of seeds; ``ATLAS_SIM_REAL_SEEDS`` raises it (the soak run
recorded in ACCEPTANCE.md used 20), ``ATLAS_SIM_SEED=<n>`` re-runs one seed.

Invariants that need the server's private history (``no_duplicates`` by operation id, the per-row
cursor check) are model-only; against the real API the harness uses what a client can observe:
convergence with the list endpoints, acknowledged responses that show what was sent, revisions that
identify one state, the entity count from the feed, and acknowledged deletes that stay deleted.
"""

from __future__ import annotations

import os

import pytest
from httpx import AsyncClient
from sqlalchemy import text

from atlas.api.auth import _login_limiter, _password_limiter
from atlas.db import session_scope
from tests.conftest import _TRUNCATE, create_user_via_setup

from .client import ClientBugs
from .engine import SimConfig, SimFailure, env_int
from .real import RealServer
from .runner import run_world

SEEDS = env_int("ATLAS_SIM_REAL_SEEDS", 3)
ONE = os.environ.get("ATLAS_SIM_SEED")

pytestmark = pytest.mark.usefixtures("_db")


def _seeds() -> list[int]:
    return [int(ONE)] if ONE else list(range(SEEDS))


@pytest.mark.parametrize("seed", _seeds())
async def test_clients_converge_on_the_real_api_under_faults(
    client: AsyncClient, seed: int
) -> None:
    await create_user_via_setup(client)
    cfg = SimConfig(steps=env_int("ATLAS_SIM_STEPS", 70), clients=3)
    world = await run_world(seed, RealServer(client), cfg)
    assert world.net.sent > 0


@pytest.mark.parametrize(
    ("bugs", "expected"),
    [
        pytest.param(
            ClientBugs(regen_key_on_retry=True), {"no_duplicates"}, id="retry without the key"
        ),
        pytest.param(ClientBugs(ignore_tombstones=True), {"convergence"}, id="tombstones ignored"),
    ],
)
async def test_the_real_api_run_can_fail(
    client: AsyncClient, bugs: ClientBugs, expected: set[str]
) -> None:
    """The same checks, pointed at the real server, catch a defect planted in the client."""
    cfg = SimConfig(steps=100, clients=3, p_drop_response=0.2)
    for seed in range(12):
        async with session_scope() as session:
            await session.execute(text(_TRUNCATE))
        _login_limiter.reset()  # the first-run setup is rate limited like a login
        _password_limiter.reset()
        await create_user_via_setup(client)
        try:
            await run_world(seed, RealServer(client), cfg, bugs)
        except SimFailure as failure:
            assert failure.invariant in expected, str(failure)
            assert f"seed={seed}" in str(failure)
            return
    pytest.fail("the planted client bug was not detected against the real API in 12 seeds")
