"""The simulated world: clients, network, server port, the schedule and the invariants (SYNC-02).

``run_world`` is the entry point: it builds a world from ``(seed, cfg, port, bugs)``, runs a faulty
phase, then a fault-free quiescence phase, and finally checks the invariants of
``docs/TESTING.md`` section 10.2. Any violation raises :class:`SimFailure` with the seed.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from typing import Any

from .client import ClientBugs, Recorder, SimClient
from .engine import EventQueue, Network, Req, ServerPort, SimConfig, SimFailure
from .model import LABEL, ModelServer

_PLURAL = {"task": "tasks", "project": "projects"}


@dataclass
class World:
    seed: int
    cfg: SimConfig
    server: ServerPort
    events: EventQueue
    net: Network
    rng: random.Random
    clock_rng: random.Random
    offsets: dict[str, list[int]]
    clients: list[SimClient]
    rec: Recorder
    trace: list[str] = field(default_factory=list)
    steps_run: int = 0

    def fail(self, invariant: str, detail: str) -> SimFailure:
        return SimFailure(self.seed, invariant, detail, self.trace)

    @property
    def model(self) -> ModelServer | None:
        return self.server if isinstance(self.server, ModelServer) else None


def build_world(
    seed: int,
    port: ServerPort,
    cfg: SimConfig | None = None,
    client_bugs: ClientBugs | None = None,
) -> World:
    cfg = cfg or SimConfig()
    trace: list[str] = []
    events = EventQueue()
    rng = random.Random(seed)
    clock_rng = random.Random(f"{seed}:clock")
    net = Network(events, port, rng, cfg, trace)
    rec = Recorder()
    offsets: dict[str, list[int]] = {}
    clients: list[SimClient] = []
    for index in range(cfg.clients):
        cid = f"c{index + 1}"
        offsets[cid] = [
            clock_rng.randint(-cfg.max_clock_skew, cfg.max_clock_skew) if cfg.skew else 0
        ]
        net.online[cid] = True
        clients.append(
            SimClient(
                cid,
                events,
                net,
                random.Random(f"{seed}:{cid}"),
                offsets[cid],
                rec,
                trace,
                client_bugs or ClientBugs(),
                cfg.timeout,
            )
        )
    return World(seed, cfg, port, events, net, rng, clock_rng, offsets, clients, rec, trace)


async def run_world(
    seed: int,
    port: ServerPort,
    cfg: SimConfig | None = None,
    client_bugs: ClientBugs | None = None,
    *,
    invariants: bool = True,
) -> World:
    """Run one seed. ``invariants=False`` only produces the final state (outcome comparisons)."""
    world = build_world(seed, port, cfg, client_bugs)
    await _faulty_phase(world)
    await _quiesce(world)
    if invariants:
        await _check_invariants(world)
        await _check_idempotence(world)
    return world


# --- schedule ------------------------------------------------------------------------------


async def _faulty_phase(world: World) -> None:
    cfg, rng = world.cfg, world.rng
    for step in range(cfg.steps):
        world.steps_run = step
        world.events.now += rng.randint(1, 15)
        await world.events.run_due()
        for client in world.clients:
            if rng.random() < cfg.action_p:
                client.user_action(cfg.kinds)
        for client in world.clients:
            if rng.random() < cfg.p_toggle_online:
                online = not world.net.online[client.cid]
                world.net.online[client.cid] = online
                world.trace.append(
                    f"t={world.events.now} {client.cid} {'ONLINE' if online else 'OFFLINE'}"
                )
                if online:
                    client.retry_at = world.events.now
            if rng.random() < cfg.p_restart:
                _check_cursor_safety(world, client)
                client.restart()
            jump = world.clock_rng.random() < cfg.p_clock_jump
            amount = world.clock_rng.randint(-cfg.max_clock_skew, cfg.max_clock_skew)
            if jump and cfg.skew:
                world.offsets[client.cid][0] = amount
        model = world.model
        if model is not None and cfg.p_purge and rng.random() < cfg.p_purge:
            cutoff = rng.randint(0, model.head_seq)
            model.purge(cutoff)
            world.trace.append(f"t={world.events.now} SERVER purge feed up to {cutoff}")
        for client in world.clients:
            client.tick()
        for client in world.clients:
            _check_cursor_safety(world, client)


async def _quiesce(world: World) -> None:
    """Faults off, everyone online: drive until all queues are empty and all clients are at head."""
    world.net.faults = False
    for cid in world.net.online:
        world.net.online[cid] = True
    for client in world.clients:
        client.retry_at = 0
        client.failures = 0
    world.trace.append(f"t={world.events.now} --- quiescence (faults off, all online) ---")
    for _ in range(world.cfg.max_quiesce_ticks):
        world.events.now += 10
        await world.events.run_due()
        for client in world.clients:
            client.tick()
        if await _quiescent(world):
            return
    stuck = [
        f"{c.cid}: queue={[o.op_id for o in c.durable.queue]} job={c.job is not None} "
        f"cursor={c.durable.cursor} clean={c.pulls_clean}"
        for c in world.clients
    ]
    raise world.fail(
        "bounded_work",
        f"did not quiesce within {world.cfg.max_quiesce_ticks} ticks after faults stopped: {stuck}",
    )


async def _quiescent(world: World) -> bool:
    if world.events.pending():
        return False
    head = await world.server.head()
    return all(c.idle() and c.pulls_clean >= 2 and c.durable.cursor == head for c in world.clients)


# --- invariants ----------------------------------------------------------------------------


def _check_cursor_safety(world: World, client: SimClient) -> None:
    """A client cursor never exceeds what it has applied; the model also checks the entities."""
    d = client.durable
    if d.cursor > d.applied_cursor:
        raise world.fail(
            "cursor_safety",
            f"{client.cid} stores cursor {d.cursor} but has applied pages only up to "
            f"{d.applied_cursor}",
        )
    model = world.model
    if model is None or not world.cfg.check_cursor_rows:
        return
    for row in model.feed.values():
        if row.seq > d.cursor:
            continue
        local = d.mirror.get(row.entity_id)
        if row.operation == "delete":
            ok = (
                local is None or local.deleted
            )  # a client that never saw it need not hold a tombstone
        else:
            ok = local is not None and not local.deleted and (local.revision or 0) >= row.revision
        if not ok:
            raise world.fail(
                "cursor_safety",
                f"{client.cid} has cursor {d.cursor} but never applied feed row #{row.seq} "
                f"({row.operation} {row.kind} {row.entity_id} rev {row.revision}); "
                f"mirror has {local}",
            )


async def server_truth(world: World) -> dict[str, tuple[str, dict[str, Any], int]]:
    """Live entities as the server reports them through its list endpoints."""
    truth: dict[str, tuple[str, dict[str, Any], int]] = {}
    for kind, plural in _PLURAL.items():
        resp = await world.server.handle(Req("GET", f"/api/{plural}"))
        if resp.status != 200:
            raise world.fail("harness", f"listing {plural} returned {resp.status}")
        for row in resp.body[plural]:
            truth[row["id"]] = (
                kind,
                {LABEL[kind]: row.get(LABEL[kind]), "description": row.get("description")},
                row["revision"],
            )
    return truth


async def all_server_entities(world: World) -> list[str]:
    """Every entity id the feed has ever announced (live and deleted), from cursor 0."""
    seen: list[str] = []
    since = 0
    for _ in range(10_000):
        resp = await world.server.handle(
            Req("GET", "/api/changes", params={"since": since, "limit": 500})
        )
        body = resp.body
        if body["resync_required"]:
            break
        seen.extend(c["entity_id"] for c in body["changes"])
        if not body["has_more"]:
            break
        since = body["next_since"]
    return seen


async def _check_invariants(world: World) -> None:
    truth = await server_truth(world)
    rec = world.rec
    # 0. a client must never send one key for two different requests
    if rec.self_inflicted:
        raise world.fail("idempotency_key_stability", "; ".join(rec.self_inflicted[:3]))
    # 1. convergence
    for client in world.clients:
        _check_cursor_safety(world, client)
        live = {i: e for i, e in client.durable.mirror.items() if not e.deleted}
        for entity_id, (kind, fields, revision) in truth.items():
            local = live.get(entity_id)
            if local is None or local.fields != fields or local.revision != revision:
                raise world.fail(
                    "convergence",
                    f"{client.cid} disagrees with the server about {kind} {entity_id}: "
                    f"server {fields} rev {revision}, client {local}",
                )
        for entity_id in live:
            if entity_id not in truth:
                raise world.fail(
                    "convergence",
                    f"{client.cid} still shows {live[entity_id].kind} {entity_id} which the server "
                    f"no longer lists (deleted or never existed)",
                )
    # 2. what the server acknowledged was applied: the response shows exactly what was sent
    for cid, op, status, body in rec.acks:
        if op.action in ("create", "patch") and isinstance(body, dict):
            for name, value in op.fields.items():
                if body.get(name) != value:
                    raise world.fail(
                        "no_acknowledged_loss",
                        f"{cid} was acknowledged for {op.op_id} ({op.action}, {status}) but the "
                        f"response "
                        f"shows {name}={body.get(name)!r}, not the {value!r} it sent",
                    )
    # 3. revision identifies state: no two different states share one (entity, revision)
    seen_states: dict[tuple[str, int], dict[str, Any]] = {}
    for _cid, op, _status, body in rec.acks:
        if isinstance(body, dict) and "id" in body and op.action != "delete":
            fields = {
                LABEL[op.kind]: body.get(LABEL[op.kind]),
                "description": body.get("description"),
            }
            previous = seen_states.setdefault((body["id"], body["revision"]), fields)
            if previous != fields:
                raise world.fail(
                    "revision_identifies_state",
                    f"{op.kind} {body['id']} revision {body['revision']} was acknowledged "
                    f"with two states: "
                    f"{previous} and {fields}",
                )
    # 4. no duplicates on retry
    creates = {op.op_id for _c, op, _s, _b in rec.acks if op.action == "create"}
    announced = set(await all_server_entities(world)) if not _purged(world) else None
    if announced is not None and len(announced) != len(creates):
        raise world.fail(
            "no_duplicates",
            f"{len(creates)} creates were acknowledged but the server holds "
            f"{len(announced)} entities "
            f"(a retried create made a second entity)",
        )
    # 5. no resurrection (real server: from acknowledgements; model: from the full history)
    deleted_acked = {
        world_id
        for cid, op, status, body in rec.acks
        if op.action == "delete"
        for world_id in [_server_id(world, op)]
        if world_id
    }
    restored_acked = {
        _server_id(world, op) for _c, op, _s, _b in rec.acks if op.action == "restore"
    }
    for entity_id in deleted_acked:
        if entity_id in truth and entity_id not in restored_acked:
            raise world.fail(
                "no_resurrection",
                f"{entity_id} was deleted (acknowledged) and never restored, but the server "
                "lists it live",
            )
    model = world.model
    if model is not None:
        _check_model_history(world, model)


def _purged(world: World) -> bool:
    model = world.model
    return model is not None and model.floor > 0


def _server_id(world: World, op: Any) -> str | None:
    for client in world.clients:
        mapped = client.durable.handles.get(op.target)
        if mapped:
            return mapped
    return op.target if not op.target.startswith("h:") else None


def _check_model_history(world: World, model: ModelServer) -> None:
    applied: dict[str, int] = {}
    state: dict[str, str] = {}
    for event in model.history:
        if event.op_id != "?":
            applied[event.op_id] = applied.get(event.op_id, 0) + 1
            if applied[event.op_id] > 1:
                raise world.fail(
                    "no_duplicates",
                    f"operation {event.op_id} was applied {applied[event.op_id]} times",
                )
        if event.event == "resurrect":
            raise world.fail(
                "no_resurrection",
                f"{event.entity_id} was brought back by {event.op_id} without a restore",
            )
        if event.event in ("create", "restore", "patch"):
            state[event.entity_id] = "live"
        elif event.event == "delete":
            state[event.entity_id] = "deleted"
    for cid, op, status, _body in world.rec.acks:
        if applied.get(op.op_id, 0) != 1:
            raise world.fail(
                "no_acknowledged_loss",
                f"{cid} was acknowledged ({status}) for {op.op_id} ({op.action}) but the "
                f"server applied it "
                f"{applied.get(op.op_id, 0)} times",
            )


async def _check_idempotence(world: World) -> None:
    """Another pull+push round on a quiescent system changes nothing."""
    before_head = await world.server.head()
    before = [
        {i: (e.fields, e.revision, e.deleted) for i, e in c.durable.mirror.items()}
        for c in world.clients
    ]
    for client in world.clients:
        client.next_pull_at = 0
        client.pulls_clean = 0
    for _ in range(60):
        world.events.now += 10
        await world.events.run_due()
        for client in world.clients:
            client.tick()
    after = [
        {i: (e.fields, e.revision, e.deleted) for i, e in c.durable.mirror.items()}
        for c in world.clients
    ]
    if await world.server.head() != before_head or after != before:
        raise world.fail(
            "idempotence", "an extra pull+push round on a quiescent system changed state"
        )


def canonical(world: World) -> Any:
    """Final server state used to compare runs (clock independence)."""
    model = world.model
    assert model is not None
    return model.canonical()
