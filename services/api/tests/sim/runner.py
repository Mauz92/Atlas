"""The simulated world: clients, network, server port, the schedule and the invariants (SYNC-02).

``run_world`` is the entry point: it builds a world from ``(seed, cfg, port, bugs)``, runs a faulty
phase, then a fault-free quiescence phase, and finally checks the invariants of
``docs/TESTING.md`` section 10.2. Any violation raises :class:`SimFailure` with the seed.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from typing import Any

from atlas.notes.portable import check_portable, fold
from atlas.notes.storage import normalize_note_path

from .client import ClientBugs, Recorder, SimClient
from .client_v1 import SyncSimClient
from .engine import EventQueue, Network, Req, ServerPort, SimConfig, SimFailure
from .model import FLAG, LABEL, ModelServer
from .model_notes import sha

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
    names = [f"c{index + 1}" for index in range(cfg.clients)]
    if cfg.old_client:
        names.append("old")
    for cid in names:
        offsets[cid] = [
            clock_rng.randint(-cfg.max_clock_skew, cfg.max_clock_skew) if cfg.skew else 0
        ]
        net.online[cid] = True
        factory = SyncSimClient if cfg.sync else SimClient
        client = factory(
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
        if cid == "old":
            client.protocol = 2  # type: ignore[attr-defined]
        clients.append(client)
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
    joiner = world.clients[cfg.clients - 1] if cfg.late_joiner else None
    if joiner is not None:
        world.net.online[joiner.cid] = False  # not yet installed: no actions, no requests
        joiner.active = False  # type: ignore[attr-defined]
    for step in range(cfg.steps):
        world.steps_run = step
        if joiner is not None and step == int(cfg.steps * 0.6):
            joiner.active = True  # type: ignore[attr-defined]
            world.net.online[joiner.cid] = True
            joiner.retry_at = joiner.next_pull_at = world.events.now
            world.trace.append(f"t={world.events.now} {joiner.cid} JOINS with an empty store")
        world.events.now += rng.randint(1, 15)
        await world.events.run_due()
        for client in world.clients:
            if rng.random() < cfg.action_p:
                client.user_action(cfg.kinds)
        for client in world.clients:
            if client is joiner and not joiner.active:  # type: ignore[attr-defined]
                continue
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
    return all(
        _halted(c) or (c.idle() and c.pulls_clean >= 2 and c.durable.cursor == head)
        for c in world.clients
    )


def _halted(client: SimClient) -> bool:
    return bool(getattr(client, "halted", False))


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
        if row.entity_id in d.refetch:
            # An acknowledged write of this client brought the entity into the mirror after its
            # cursor had passed the row (a snapshot omits tombstones, a replayed create answers
            # with the first result): the entity is queued to be read again at the next pull
            # (SYNC_PROTOCOL.md 8.1), which is the correction.
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
                {
                    LABEL[kind]: row.get(LABEL[kind]),
                    "description": row.get("description"),
                    FLAG[kind]: row.get(FLAG[kind]),
                },
                row["revision"],
            )
    resp = await world.server.handle(Req("GET", "/api/notes"))
    if resp.status != 200:
        raise world.fail("harness", f"listing notes returned {resp.status}")
    for row in resp.body["notes"]:
        detail = await world.server.handle(Req("GET", f"/api/notes/{row['id']}"))
        if detail.status != 200:
            raise world.fail("harness", f"reading note {row['id']} returned {detail.status}")
        truth[row["id"]] = (
            "note",
            {"path": detail.body["path"], "content": detail.body["content"]},
            detail.body["revision"],
        )
    return truth


async def _check_invariants(world: World) -> None:
    truth = await server_truth(world)
    rec = world.rec
    # 0. a client must never send one key for two different requests
    if rec.self_inflicted:
        raise world.fail("idempotency_key_stability", "; ".join(rec.self_inflicted[:3]))
    # 1. convergence
    for client in world.clients:
        if _halted(client):
            continue
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
        if op.kind == "note":
            _check_note_ack(world, cid, op, status, body)
            continue
        if op.action in ("create", "patch") and isinstance(body, dict):
            sync = body.get("sync") if world.cfg.sync else None
            held_back = {c["field"] for c in sync["conflicts"]} if sync else set()
            for name, value in op.fields.items():
                if name not in held_back and body.get(name) != value:
                    raise world.fail(
                        "no_acknowledged_loss",
                        f"{cid} was acknowledged for {op.op_id} ({op.action}, {status}) but the "
                        f"response "
                        f"shows {name}={body.get(name)!r}, not the {value!r} it sent",
                    )
    # 3. revision identifies state: no two different states share one (entity, revision)
    seen_states: dict[tuple[str, int], dict[str, Any]] = {}
    for _cid, op, _status, body in rec.acks:
        if op.kind == "note" and isinstance(body, dict) and "content_hash" in body:
            note_state = {"path": body["path"], "hash": body["content_hash"]}
            note_previous = seen_states.setdefault((body["id"], body["revision"]), note_state)
            if note_previous != note_state:
                raise world.fail(
                    "revision_identifies_state",
                    f"note {body['id']} revision {body['revision']} was acknowledged with two "
                    f"states: {note_previous} and {note_state}",
                )
            continue
        if isinstance(body, dict) and "id" in body and op.action != "delete":
            fields = {
                LABEL[op.kind]: body.get(LABEL[op.kind]),
                "description": body.get("description"),
                FLAG[op.kind]: body.get(FLAG[op.kind]),
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
    copies = {copy["id"] for _c, _o, copy in rec.conflict_copies}
    announced = set(await world.server.all_entity_ids())
    if announced is not None and len(announced) != len(creates) + len(copies):
        raise world.fail(
            "no_duplicates",
            f"{len(creates)} creates were acknowledged and {len(copies)} conflict copies were "
            f"reported, but the server holds {len(announced)} entities "
            f"(a retried create or conflict made a second entity)",
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
    edited_acked = {
        _server_id(world, op)
        for _c, op, _s, _b in rec.acks
        if op.action in ("patch", "restore", "put")
    }
    for entity_id in deleted_acked:
        if world.cfg.sync and entity_id in edited_acked:
            continue  # edit wins over delete (rule 4): an acknowledged edit may bring it back
        if entity_id in truth and entity_id not in restored_acked:
            raise world.fail(
                "no_resurrection",
                f"{entity_id} was deleted (acknowledged) and never restored, but the server "
                "lists it live",
            )
    if world.cfg.sync:
        _check_sync_world(world)
        await _check_notes(world, truth)
    model = world.model
    if model is not None:
        _check_model_history(world, model)


def _check_sync_world(world: World) -> None:
    """Invariants that only exist in protocol v1 (TESTING.md section 10.2)."""
    rec = world.rec
    # the only refusals an honest client may meet are the two designed ones (and a restore of a
    # task that is no longer deleted); a 404 on a patch of a
    # known entity would mean edit-wins-over-delete is broken, a 422 a client/server mismatch
    for cid, op, status, code in rec.refusals:
        if op.action == "restore" and status == 404:
            continue  # nothing to restore: another device's edit already brought the task back
        expected = {
            "conflict": ("patch", "put"),
            "edit_wins": ("delete",),
            "path_exists": ("move",),
            "note_deleted": ("move",),
        }
        if code not in expected or op.action not in expected[code]:
            raise world.fail(
                "unexpected_rejection",
                f"{cid} was refused {op.action} {op.op_id} with {status} {code!r}: only a text "
                "conflict, a stale delete (edit wins) and, for notes, a taken path or a move of a "
                "deleted note are expected",
            )
    # a client speaking an unsupported protocol stops at the first 426 and writes nothing
    for client in world.clients:
        if client.cid != "old":
            continue
        sent = getattr(client, "sent", -1)
        if client.cid not in rec.halts or sent != getattr(client, "sent_at_halt", -2):
            raise world.fail(
                "stop_on_426",
                f"the unsupported client sent {sent} requests, halted={client.cid in rec.halts} "
                f"(sent {getattr(client, 'sent_at_halt', None)} when it halted); it must stop "
                "at the first 426 it receives and send nothing after",
            )
        if any(o.op_id.startswith("old-") for _c, o, _s, _b in rec.acks):
            raise world.fail("stop_on_426", "an unsupported client had a write acknowledged")


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
    if world.cfg.sync:
        _check_model_sync_history(world, model)
        _check_model_note_history(world, model)
    for cid, op, status, _body in world.rec.acks:
        if world.cfg.sync and op.action != "create" and applied.get(op.op_id, 0) <= 1:
            continue  # a merged patch may be a no-op (equal values), a repeated delete a no-op
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


def _check_model_sync_history(world: World, model: ModelServer) -> None:
    """Merge safety, read from the model's ground truth (never available on the real API)."""
    text = {"title", "name", "description"}
    for event in model.history:
        if event.event in ("patch", "revive"):
            for name, changed_at, _equal in event.writes:
                if name in text and event.base is not None and changed_at > event.base:
                    raise world.fail(
                        "no_silent_text_loss",
                        f"{event.op_id} overwrote text field {name} of {event.entity_id}, which "
                        f"changed at revision {changed_at} after its base {event.base}",
                    )
        if (
            event.event == "delete"
            and event.base is not None
            and event.revision_before is not None
            and event.base < event.revision_before
        ):
            raise world.fail(
                "edit_wins",
                f"{event.op_id} deleted {event.entity_id} on base {event.base} although it was "
                f"edited up to revision {event.revision_before}",
            )


# --- notes (SYNC-04) -----------------------------------------------------------------------


def _check_note_ack(world: World, cid: str, op: Any, status: int, body: Any) -> None:
    """What the server acknowledged for a note is what the client sent (a create), or contains
    everything the client's edit added (a save, which the server may have merged)."""
    if not isinstance(body, dict):
        return
    if op.action == "create" and "content" in body and body["content"] != op.fields["content"]:
        raise world.fail(
            "no_acknowledged_loss",
            f"{cid} was acknowledged for creating {op.op_id} but the response holds other text",
        )
    if op.action == "put" and body.get("content") is not None:
        present = set(body["content"].split("\n"))
        missing = sorted(op.markers - present)
        if missing:
            raise world.fail(
                "no_acknowledged_loss",
                f"{cid} was acknowledged ({status}) for save {op.op_id} but the text the server "
                f"returned lacks {missing}",
            )


async def _check_notes(world: World, truth: dict[str, tuple[str, dict[str, Any], int]]) -> None:
    """Invariants over the final state of the notes (TESTING.md section 10.2)."""
    rec, server = world.rec, world.server
    # a conflict copy holds exactly the text that lost, and exists on the server
    for cid, op, copy in rec.conflict_copies:
        want = op.fields["content"]
        if copy["content_hash"] != sha(want):
            raise world.fail(
                "conflict_copy_has_losing_text",
                f"{cid}: the copy {copy['id']} of {op.op_id} reports another hash",
            )
        first = await server.handle(Req("GET", f"/api/notes/{copy['id']}/history/1"))
        if first.status != 200 or first.body["content"] != want:
            raise world.fail(
                "conflict_copy_has_losing_text",
                f"{cid}: the conflict copy {copy['id']} of {op.op_id} does not hold the text "
                f"that lost (status {first.status})",
            )
    # paths: unique even by case or Unicode normalisation, and portable
    seen: dict[str, str] = {}
    for note_id, (kind, fields, _revision) in truth.items():
        if kind != "note":
            continue
        path = fields["path"]
        try:
            check_portable(normalize_note_path(path))
        except Exception as exc:
            raise world.fail(
                "portable_paths", f"live note {note_id} has path {path!r}: {exc}"
            ) from exc
        other = seen.setdefault(fold(path), note_id)
        if other != note_id:
            raise world.fail(
                "unique_paths",
                f"notes {other} and {note_id} have paths that differ only by case or "
                f"normalisation: {path!r}",
            )
    # nothing an acknowledged save added has disappeared, unless a later acknowledged save took
    # the line out on purpose; the last text of a deleted note still counts (it is in history)
    universe: set[str] = set()
    for note_id in await server.all_entity_ids():
        if note_id in truth:
            if truth[note_id][0] == "note":
                universe |= set(truth[note_id][1]["content"].split("\n"))
            continue
        listing = await server.handle(Req("GET", f"/api/notes/{note_id}/history"))
        if listing.status != 200 or not listing.body["revisions"]:
            continue  # a task or project
        newest = max(row["revision"] for row in listing.body["revisions"])
        last = await server.handle(Req("GET", f"/api/notes/{note_id}/history/{newest}"))
        if last.status == 200:
            universe |= set(last.body["content"].split("\n"))
    added: set[str] = set()
    removed: set[str] = set()
    for _cid, op, _status, _body in rec.acks:
        if op.kind == "note" and op.action in ("create", "put"):
            added |= op.markers
            removed |= op.removed
    for _cid, op, _copy in rec.conflict_copies:
        added |= op.markers  # they live in the copy
    lost = sorted(added - universe - removed)
    if lost:
        raise world.fail(
            "no_acknowledged_note_loss",
            f"lines added by acknowledged saves are in no note and were removed by no save: {lost}",
        )


def _check_model_note_history(world: World, model: ModelServer) -> None:
    """Merge safety from the model's ground truth: a save never drops a line it did not remove."""
    for event in model.history:
        if event.kind != "note" or event.event not in ("write", "merge", "revive"):
            continue
        ex = event.extra
        theirs, ours, after = ex.get("theirs") or "", ex["ours"], ex["after"]
        base = ex.get("base_text")
        base = theirs if base is None else base
        dropped = markers_of(theirs) - markers_of(after) - (markers_of(base) - markers_of(ours))
        if dropped:
            raise world.fail(
                "no_silent_overwrite",
                f"{event.op_id} ({event.event}) removed lines {sorted(dropped)} of "
                f"{event.entity_id} that it had not removed from its base",
            )
        if not ex.get("copy"):
            lost = markers_of(ours) - markers_of(base) - markers_of(after)
            if lost:
                raise world.fail(
                    "no_acknowledged_note_loss",
                    f"{event.op_id} ({event.event}) dropped its own additions {sorted(lost)}",
                )


def markers_of(text: str) -> frozenset[str]:
    return frozenset(line for line in text.split("\n") if line.startswith("m:"))
