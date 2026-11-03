"""The simulated world: clients, network, server port, the schedule and the invariants (SYNC-02).

``run_world`` is the entry point: it builds a world from ``(seed, cfg, port, bugs)``, runs a faulty
phase, then a fault-free quiescence phase, and finally checks the invariants of
``docs/TESTING.md`` section 10.2. Any violation raises :class:`SimFailure` with the seed.
"""

from __future__ import annotations

import json
import random
import re
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
        elif cfg.resolutions:
            client.track_resolutions = True  # type: ignore[attr-defined]
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
    if world.cfg.resolutions and world.cfg.undo_rounds:
        await _undo_wave(world)
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
        if cfg.revoke_device and step == int(cfg.steps * cfg.revoke_at):
            await world.server.revoke_device(cfg.revoke_device)  # type: ignore[attr-defined]
            world.trace.append(
                f"t={world.events.now} OWNER revokes the device of {cfg.revoke_device}"
            )
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


async def _undo_wave(world: World) -> None:
    """Second wave (SYNC-05): every client now holds the notices of the whole run. They tap undo
    on them while still editing a little and while the network misbehaves, so undos meet newer
    writes, other undos of the same notice, retries and lost answers."""
    world.net.faults = True
    world.trace.append(f"t={world.events.now} --- undo wave (faults on) ---")
    rng = world.rng
    for _ in range(world.cfg.undo_rounds):
        world.events.now += rng.randint(1, 15)
        await world.events.run_due()
        for client in world.clients:
            if _halted(client):
                continue
            roll = rng.random()
            if roll < 0.5 and isinstance(client, SyncSimClient):
                client.undo_tap()
            elif roll < 0.62:
                client.user_action(world.cfg.kinds)
        for client in world.clients:
            client.tick()
        for client in world.clients:
            _check_cursor_safety(world, client)


async def _quiescent(world: World) -> bool:
    if world.events.pending():
        return False
    head = await world.server.head()
    return all(
        _halted(c)
        or (
            c.cid != world.cfg.revoke_device  # a revoked client is done only once it has been told
            and c.idle()
            and c.pulls_clean >= 2
            and c.durable.cursor == head
        )
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
        if row.kind == "resolution":
            if not getattr(client, "track_resolutions", False):
                continue  # this client never asked for the entity
            held = d.resolutions.get(row.entity_id)
            have = None if held is None else (2 if held["undone_at"] else 1)
            if have is None or have < row.revision:
                raise world.fail(
                    "cursor_safety",
                    f"{client.cid} has cursor {d.cursor} but never applied resolution row "
                    f"#{row.seq} ({row.entity_id} state {row.revision}); holds {held}",
                )
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
    # A revoked device may have had a create (or a note save that became a conflict copy) applied
    # whose answer it never received: that entity is real but unacknowledged, never a duplicate.
    slack = sum(
        1
        for client in world.clients
        if client.cid in world.rec.revoked_halts
        for op in client.durable.queue
        if op.action in ("create", "put")
    )
    expected = len(creates) + len(copies)
    if announced is not None and not expected <= len(announced) <= expected + slack:
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
    if world.cfg.resolutions:
        await _check_resolutions(world)
    if world.cfg.devices:
        await _check_devices(world)
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
    # A revoked device may have had a save applied whose answer it never received: the server
    # holds its removals, the harness never saw an acknowledgement (found by the SYNC-06 soak,
    # seed 19 at 150 steps). Those lines were removed by a save, just not an acknowledged one.
    for client in world.clients:
        if client.cid in rec.revoked_halts:
            for op in client.durable.queue:
                if op.kind == "note" and op.action in ("create", "put"):
                    removed |= op.removed
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


# --- resolutions and undo (SYNC-05) ---------------------------------------------------------

#: rules that always accompany a revision bump of their entity: two entries for the same
#: (entity, rule, field, revision) can only be one write logged twice (an undo that changed
#: nothing bumps no revision, so undo is not in the set; `undo_once` covers it)
_ONE_PER_REVISION = frozenset(
    {"simple_later_wins", "path_later_wins", "edit_wins_over_delete", "path_collision"}
)
_LOSER_RULES = frozenset({"simple_later_wins", "path_later_wins", "undo"})
_UNDO_REFUSALS = frozenset(
    {"conflict", "entity_deleted", "already_undone", "not_undoable", "path_exists"}
)
#: what a simulated user types: task titles, descriptions and note lines (never a simple value)
_TEXT = re.compile(r"(task|project):c\d+-\d+|\bd:c\d+-\d+|\bm:c\d+-\d+|# Title")


async def fetch_log(world: World) -> list[dict[str, Any]]:
    """The whole resolution log through the list endpoint (newest first), as a client sees it."""
    entries: list[dict[str, Any]] = []
    cursor: str | None = None
    for _ in range(1000):
        params: dict[str, Any] = {"limit": 200}
        if cursor is not None:
            params["cursor"] = cursor
        resp = await world.server.handle(
            Req("GET", "/api/sync/resolutions", params=params, headers={"Atlas-Sync": "1"})
        )
        if resp.status != 200:
            raise world.fail("harness", f"listing the resolution log returned {resp.status}")
        entries += resp.body["resolutions"]
        cursor = resp.body["next_cursor"]
        if cursor is None:
            return entries
    raise world.fail("harness", "the resolution log did not end")


async def _check_resolutions(world: World) -> None:
    """Invariants of the resolution log and undo (TESTING.md section 10.0c)."""
    rec = world.rec
    log = await fetch_log(world)
    by_id = {e["id"]: e for e in log}
    if len(by_id) != len(log):
        raise world.fail("resolution_logged_once", "the log lists an entry id twice")
    # the log never holds text, only simple values and ids
    for entry in log:
        blob = json.dumps(entry, default=str)
        if _TEXT.search(blob) or (entry["has_loser"] and entry["rule"] not in _LOSER_RULES):
            raise world.fail(
                "log_has_no_text", f"entry {entry['id']} ({entry['rule']}) keeps text: {blob[:200]}"
            )
    # exactly once: no two entries describe the same write (a retry, a replay)
    writes: dict[tuple[Any, ...], str] = {}
    for entry in log:
        if entry["rule"] in _ONE_PER_REVISION and entry["kept_revision"] is not None:
            key = (entry["entity_id"], entry["rule"], entry["field"], entry["kept_revision"])
            if key in writes:
                raise world.fail(
                    "resolution_logged_once",
                    f"entries {writes[key]} and {entry['id']} both record {key}: one write "
                    "was logged twice",
                )
            writes[key] = entry["id"]
    # every resolution a client was told about is in the log, with the same facts ...
    told = rec.seen_resolutions
    for rid, (op_id, out) in told.items():
        entry = by_id.get(rid)
        if entry is None:
            raise world.fail(
                "resolution_logged_once",
                f"{op_id} was answered with resolution {rid} ({out['rule']}) that the log lacks",
            )
        same = (entry["rule"], entry["field"], entry["kept_revision"]) == (
            out["rule"],
            out.get("field"),
            out.get("kept_revision"),
        )
        if not same:
            raise world.fail(
                "resolution_logged_once",
                f"{op_id} was told {out} but the log holds {entry['rule']} {entry['field']} "
                f"revision {entry['kept_revision']}",
            )
    # ... and the log holds nothing no write reported (an entry without its write, or a retry
    # that wrote again and was never answered)
    for entry in log:
        if entry["id"] not in told:
            name = "undo_idempotent" if entry["rule"] == "undo" else "no_log_without_write"
            raise world.fail(
                name,
                f"log entry {entry['id']} ({entry['rule']} of {entry['entity_id']} at revision "
                f"{entry['kept_revision']}) was reported to no client: no acknowledged write "
                "produced it",
            )
    # undo: at most one undo entry per resolution, the flag agrees with the entries
    undo_of: dict[str, list[str]] = {}
    for entry in log:
        if entry["rule"] == "undo" and entry["undoes_id"]:
            undo_of.setdefault(entry["undoes_id"], []).append(entry["id"])
    for target, entries in undo_of.items():
        if len(entries) > 1:
            raise world.fail("undo_once", f"resolution {target} has undo entries {entries}")
    for entry in log:
        if entry["rule"] == "undo":
            continue
        count = len(undo_of.get(entry["id"], ()))
        if (entry["undone_at"] is not None) != (count == 1):
            raise world.fail(
                "undo_logged",
                f"resolution {entry['id']} is marked undone={entry['undone_at'] is not None} "
                f"but has {count} undo entries",
            )
    for cid, op, _status, body in rec.undos:
        entry = by_id.get(body["undo"]["id"]) if body["undo"].get("id") else None
        if entry is None or entry["undoes_id"] != op.target:
            raise world.fail(
                "undo_logged",
                f"{cid} was answered {body['undo']} for undo {op.op_id} but the log holds no "
                f"undo entry of {op.target}",
            )
        if (
            body["applied"]
            and op.target in rec.winners
            and entry["loser"] != rec.winners[op.target]
        ):
            raise world.fail(
                "undo_never_overwrites_newer",
                f"undo {op.op_id} replaced {entry['loser']!r} but the winning write of "
                f"{op.target} had stored {rec.winners[op.target]!r}: a newer value was overwritten",
            )
    for cid, op, status, code in rec.undo_refusals:
        if code not in _UNDO_REFUSALS:
            raise world.fail(
                "unexpected_rejection",
                f"{cid} was refused undo {op.op_id} with {status} {code!r}",
            )
    # every client that follows the entity holds exactly the log (notices converge)
    truth = {e["id"]: e["undone_at"] is not None for e in log}
    for client in world.clients:
        if _halted(client) or not getattr(client, "track_resolutions", False):
            continue
        mine = {i: r["undone_at"] is not None for i, r in client.durable.resolutions.items()}
        if mine != truth:
            missing = sorted(set(truth) - set(mine))
            differing = sorted(i for i in mine if i in truth and mine[i] != truth[i])
            raise world.fail(
                "resolutions_converge",
                f"{client.cid} disagrees with the server's log: missing {missing[:5]}, "
                f"differing {differing[:5]}, unknown {sorted(set(mine) - set(truth))[:5]}",
            )
    model = world.model
    if model is not None:
        _check_model_resolutions(world, model)


def _check_model_resolutions(world: World, model: ModelServer) -> None:
    """Ground truth only the model has: every generated resolution has exactly one row, and no
    undo replaced a value that changed after the resolution."""
    if len(model.res_log) != model.generated:
        raise world.fail(
            "resolution_logged_once",
            f"{model.generated} resolutions were generated by writes but the log holds "
            f"{len(model.res_log)} rows",
        )
    for truth in model.undo_truth:
        if "winner_path" in truth:
            ok = truth["before"] == truth["winner_path"]
        else:
            ok = truth["field_revision_before"] <= truth["kept_revision"]
        if not ok:
            raise world.fail(
                "undo_never_overwrites_newer",
                f"undo of {truth['resolution']} replaced {truth['before']!r} although the field "
                f"had changed (revision {truth['field_revision_before']}) after the resolution "
                f"(revision {truth['kept_revision']})",
            )


def check_log_matches_state(model: ModelServer) -> str | None:
    """A restored (or any) server must not hold a log entry whose write is not in its state:
    every entry's entity exists and has reached the entry's revision."""
    for entry in model.res_log:
        entity = model.entities.get(entry["entity_id"])
        if entity is None:
            return f"entry {entry['id']} refers to {entry['entity_id']} which does not exist"
        if entry["kept_revision"] is not None and entry["kept_revision"] > entity.revision:
            return (
                f"entry {entry['id']} records revision {entry['kept_revision']} of "
                f"{entry['entity_id']}, which is only at revision {entity.revision}"
            )
    return None


async def _check_devices(world: World) -> None:
    """SYNC-06: which device wrote, and what a revoked device may still do."""
    server: Any = world.server
    rec = world.rec
    log = await fetch_log(world)
    by_id = {e["id"]: e for e in log}
    device_of = {cid: device_id for cid, (_c, device_id) in server.devices.items()}
    # every entry names the device of the client whose request produced it ...
    for rid, (op_id, _out) in rec.seen_resolutions.items():
        cid = op_id.rsplit("-", 1)[0]
        entry = by_id.get(rid)
        if entry is not None and entry["device_id"] != device_of[cid]:
            raise world.fail(
                "resolution_device",
                f"resolution {rid} was produced by {op_id} of {cid} (device {device_of[cid]}) but "
                f"the log names device {entry['device_id']}",
            )
    for cid, op, _status, body in rec.undos:
        entry = by_id.get(body["undo"]["id"]) if body["undo"].get("id") else None
        if entry is not None and entry["device_id"] != device_of[cid]:
            raise world.fail(
                "resolution_device",
                f"undo {op.op_id} of {cid} (device {device_of[cid]}) is logged for "
                f"device {entry['device_id']}",
            )
    # ... and none is anonymous: every client in this world is a device
    for entry in log:
        if entry["device_id"] not in device_of.values():
            raise world.fail(
                "resolution_device", f"entry {entry['id']} names device {entry['device_id']!r}"
            )
    # a revoked device is never served again, and its client stops at the first refusal
    if server.served_after_revoke:
        raise world.fail(
            "revoked_never_served",
            f"requests of a revoked device were answered 2xx: {server.served_after_revoke[:3]}",
        )
    for cid in server.revoked:
        client = next(c for c in world.clients if c.cid == cid)
        sent = getattr(client, "sent", -1)
        if cid not in rec.revoked_halts or sent != getattr(client, "sent_at_halt", -2):
            raise world.fail(
                "stop_on_revoked",
                f"{cid} sent {sent} requests, halted={cid in rec.revoked_halts} (sent "
                f"{getattr(client, 'sent_at_halt', None)} at the halt): it must stop at the first "
                "token_revoked and send nothing after",
            )
