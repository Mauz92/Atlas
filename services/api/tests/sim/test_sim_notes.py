"""The simulation with notes (SYNC-04): three-way merge, conflict copies, edit-wins, revive, moves
and portable paths under faults, many clients and many seeds; model server first, real API at the
bottom. Defaults: 100 model seeds, 3 real seeds; ``ATLAS_SIM_SEEDS`` / ``ATLAS_SIM_REAL_SEEDS`` /
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
    kw.setdefault("kinds", ("task", "project", "note"))
    kw.setdefault("steps", STEPS)
    return SimConfig(sync=True, **kw)  # type: ignore[arg-type]


@pytest.mark.parametrize("seed", _seeds())
async def test_clients_converge_with_notes_under_faults(seed: int) -> None:
    await run_world(seed, ModelServer(), _cfg())


@pytest.mark.parametrize("seed", _seeds())
async def test_notes_only_runs_converge(seed: int) -> None:
    await run_world(seed, ModelServer(), _cfg(kinds=("note",), clients=4, action_p=0.5))


@pytest.mark.parametrize("seed", _seeds(40))
async def test_a_late_joiner_and_purges_with_notes(seed: int) -> None:
    cfg = _cfg(kinds=("note", "task"), late_joiner=True, clients=4, p_purge=0.05)
    await run_world(seed, ModelServer(), cfg)


@pytest.mark.parametrize("seed", _seeds(40))
async def test_final_note_state_does_not_depend_on_client_clocks(seed: int) -> None:
    skewed = await run_world(seed, ModelServer(), _cfg(kinds=("note",), skew=True))
    straight = await run_world(seed, ModelServer(), _cfg(kinds=("note",), skew=False))
    assert canonical(skewed) == canonical(straight), (
        f"seed={seed}: client clocks changed the outcome"
    )


async def test_the_note_runs_exercise_every_outcome() -> None:
    """The runs must merge, conflict, revive, refuse and collide, or the seeds prove little."""
    seen = {
        "merged": 0, "conflict": 0, "overlap_revive": 0, "revive": 0, "edit_wins": 0,
        "path_exists": 0, "collision": 0, "note_deleted": 0, "copy": 0,
    }  # fmt: skip
    for seed in range(40):
        server = ModelServer()
        world = await run_world(seed, server, _cfg(kinds=("note",), clients=4, action_p=0.5))
        for _c, _o, _s, code in world.rec.refusals:
            if code in seen:
                seen[code] += 1
        for _c, op, _s, body in world.rec.acks:
            if not isinstance(body, dict) or op.kind != "note":
                continue
            sync = body.get("sync") or {}
            seen["merged"] += bool(sync.get("merged"))
            seen["collision"] += any(
                r["rule"] == "path_collision" for r in sync.get("resolution", [])
            )
        seen["revive"] += sum(1 for e in server.history if e.event == "revive")
        seen["copy"] += len(world.rec.conflict_copies)
    for name in ("merged", "conflict", "revive", "edit_wins", "path_exists", "collision", "copy"):
        assert seen[name] > 0, seen


# --- the harness can fail: one planted defect per note invariant -----------------------------

_CASES = [
    (
        "a stale save overwrites the note",
        ServerBugs(notes_overwrite_on_stale=True),
        None,
        {"no_silent_overwrite", "no_acknowledged_note_loss", "convergence"},
    ),
    (
        "a merge drops the client's edit",
        ServerBugs(notes_merge_drops_ours=True),
        None,
        {"no_acknowledged_loss", "no_acknowledged_note_loss"},
    ),
    (
        "an acknowledged save is not applied",
        ServerBugs(notes_drop_acknowledged_write=True),
        None,
        {"no_acknowledged_loss", "no_acknowledged_note_loss"},
    ),
    (
        "paths differing by case may coexist",
        ServerBugs(notes_ignore_path_collisions=True),
        None,
        {"unique_paths"},
    ),
    (
        "the conflict copy keeps half the text",
        ServerBugs(notes_conflict_copy_truncated=True),
        None,
        {"conflict_copy_has_losing_text"},
    ),
    (
        "a retried conflict saves another copy",
        ServerBugs(notes_conflict_not_stored=True),
        None,
        {"no_duplicates", "cursor_safety", "convergence"},
    ),
    (
        "a stale delete wins over an edit",
        ServerBugs(stale_delete_wins=True),
        None,
        {"edit_wins"},
    ),
    (
        "an edit of a deleted note is 404",
        ServerBugs(no_revive=True),
        None,
        {"unexpected_rejection"},
    ),
    (
        "the server ignores idempotency keys",
        ServerBugs(ignore_idempotency=True),
        None,
        {"no_duplicates"},
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
async def test_each_planted_note_defect_is_caught(
    name: str,
    server_bugs: ServerBugs | None,
    client_bugs: ClientBugs | None,
    expected: set[str],
) -> None:
    # conflicts need concurrent stale saves; a retried one needs a lost reply: longer runs find it
    steps = 700 if "retried conflict" in name else STEPS
    cfg = _cfg(kinds=("note",), clients=4, action_p=0.5, p_drop_response=0.15, steps=steps)
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
async def test_note_clients_converge_on_the_real_api(notes_client: AsyncClient, seed: int) -> None:
    await create_user_via_setup(notes_client)
    cfg = SimConfig(
        steps=env_int("ATLAS_SIM_STEPS", 70),
        clients=3,
        sync=True,
        kinds=("note", "task"),
        action_p=0.45,
        late_joiner=True,
        old_client=True,
    )
    world = await run_world(seed, RealServer(notes_client), cfg)
    assert world.net.sent > 0
