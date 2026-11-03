"""Device credentials in the simulation, against the real API (SYNC-06).

Every simulated client signs in as its own device (the public sign-in endpoint, a bearer token, no
cookies, no CSRF) and runs the same hostile schedule as the resolution simulation. Added
invariants: each resolution names the device of the client whose request produced it (undo entries
the undoing client's), no entry is anonymous, a device the owner revoked mid-run is never served
2xx again and its client stops at the first ``token_revoked``. A planted client defect (keeps
writing after ``token_revoked``) must trip ``stop_on_revoked``.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from httpx import AsyncClient

from tests.conftest import create_user_via_setup

from .client import ClientBugs
from .engine import SimConfig, SimFailure, env_int
from .real import RealServer
from .runner import run_world

SEEDS = env_int("ATLAS_SIM_REAL_SEEDS", 3)
STEPS = env_int("ATLAS_SIM_STEPS", 70)

pytestmark = pytest.mark.usefixtures("_db")


def _cfg(**over: object) -> SimConfig:
    return SimConfig(
        **{
            "steps": STEPS,
            "clients": 3,
            "sync": True,
            "resolutions": True,
            "kinds": ("task", "project", "note"),
            "late_joiner": True,
            "action_p": 0.5,
            "undo_rounds": 25,
            "devices": True,
            **over,
        }  # type: ignore[arg-type]
    )


async def _server(app: FastAPI, client: AsyncClient, cfg: SimConfig) -> RealServer:
    await create_user_via_setup(client, email="sim@example.com", password="simulation password 1")
    server = RealServer(client, app)
    for index in range(cfg.clients):
        await server.add_device(
            f"c{index + 1}", email="sim@example.com", password="simulation password 1"
        )
    return server


@pytest.mark.parametrize("seed", range(SEEDS))
async def test_devices_are_named_in_the_log_and_a_revoked_one_is_never_served(
    app: FastAPI, notes_client: AsyncClient, seed: int
) -> None:
    cfg = _cfg(revoke_device="c2")
    server = await _server(app, notes_client, cfg)
    world = await run_world(seed, server, cfg)
    assert world.net.sent > 0
    assert "c2" in world.rec.revoked_halts
    assert server.revoked == {"c2"}


@pytest.mark.parametrize("seed", range(SEEDS))
async def test_every_client_a_device_no_revocation(
    app: FastAPI, notes_client: AsyncClient, seed: int
) -> None:
    cfg = _cfg()
    server = await _server(app, notes_client, cfg)
    await run_world(seed, server, cfg)
    assert not server.revoked


async def test_a_client_that_ignores_token_revoked_is_caught(
    app: FastAPI, notes_client: AsyncClient
) -> None:
    """Planted defect: the client keeps retrying after ``401 token_revoked``. The invariant must
    name it, with the seed (seed 1 passes for a correct client in the test above)."""
    cfg = _cfg(revoke_device="c2", steps=60)
    server = await _server(app, notes_client, cfg)
    with pytest.raises(SimFailure) as failure:
        await run_world(1, server, cfg, ClientBugs(ignore_revoked=True))
    # a client that never stops is also work that never ends: either invariant names the defect
    assert failure.value.invariant in {"stop_on_revoked", "bounded_work"}
    assert "seed=1" in str(failure.value)
