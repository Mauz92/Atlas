"""A model sync client for today's API (SYNC-02).

It models the *intended* client protocol of SYNC_PROTOCOL.md §1/§6/§7 on top of the current
endpoints, not the shipped TypeScript (see ROADMAP SYNC-02 for why and for the SYNC-08 follow-up):

- a **durable** part that survives a restart: the operation queue (each operation carries its
  idempotency key from the moment it is enqueued), a mirror of server state, the id mapping of
  entities created offline, and the pull cursor;
- a **volatile** part that a restart destroys: the request in flight, the half-done pull and the
  backoff timers;
- one request in flight at a time, FIFO queue, retry of the *same* request with the *same* key on
  anything but a definite answer, jittered exponential backoff;
- pull = feed page, then ``GET`` of every upserted entity (the feed carries no payload), then a
  single atomic commit of the fetched entities **and** the new cursor; a ``resync_required`` page
  triggers a full listing and a cursor reset to the head the server reported.

:class:`ClientBugs` plants one defect per flag, each used by a test that proves the matching
invariant fails.
"""

from __future__ import annotations

import random
import uuid
from dataclasses import dataclass, field
from typing import Any

from .engine import EventQueue, Network, Req, Resp
from .model import LABEL

_PLURAL = {"task": "tasks", "project": "projects"}


@dataclass
class ClientBugs:
    #: persist the cursor when the feed page arrives, before the entities are fetched and applied
    advance_cursor_before_apply: bool = False
    #: a retry of an operation gets a new idempotency key
    regen_key_on_retry: bool = False
    #: a feed ``delete`` is not applied to the mirror
    ignore_tombstones: bool = False
    #: apply fetched entities even when their revision is older than the mirror's
    apply_stale_revisions: bool = False
    #: keep the queue sorted by the client's own (skewed) clock instead of FIFO
    queue_ordered_by_client_clock: bool = False


@dataclass
class Op:
    op_id: str
    kind: str
    action: str  # create | patch | delete | restore
    target: str  # for create: the local handle the new entity is known by until acknowledged
    fields: dict[str, Any]
    use_base: bool
    key: str
    ts: int  # client clock at enqueue; must never influence ordering
    #: ``base_revision`` fixed at the first send and then persisted: a retry must be byte-identical
    #: (the server fingerprints the request, so a changed base under the same key is a 409 mismatch)
    base_fixed: bool = False
    base: int | None = None
    attempts: int = (
        0  # how many times this operation has been sent (volatile in spirit; used by a planted bug)
    )


@dataclass
class Local:
    kind: str
    fields: dict[str, Any]
    revision: int | None  # None for a tombstone: the API gives no revision for deleted entities
    deleted: bool = False


@dataclass
class Durable:
    queue: list[Op] = field(default_factory=list)
    mirror: dict[str, Local] = field(default_factory=dict)
    handles: dict[str, str] = field(default_factory=dict)
    cursor: int = 0
    #: highest cursor whose page was fully applied (the invariant compares it with ``cursor``)
    applied_cursor: int = 0
    counter: int = 0


@dataclass
class Inflight:
    attempt: int
    kind: str  # push | feed | get | list
    deadline: int
    detail: Any = None


@dataclass
class PullJob:
    since: int
    stage: str = "feed"
    page: dict[str, Any] | None = None
    todo: list[tuple[str, str]] = field(default_factory=list)
    fetched: dict[tuple[str, str], dict[str, Any] | None] = field(default_factory=dict)
    lists: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    resync_head: int = 0


@dataclass
class Recorder:
    """What the world needs to know to judge a run (shared by all clients)."""

    acks: list[tuple[str, Op, int, Any]] = field(default_factory=list)
    drops: list[tuple[str, Op, int]] = field(default_factory=list)
    observations: list[tuple[str, str, str]] = field(
        default_factory=list
    )  # client, entity, live|deleted
    self_inflicted: list[str] = field(default_factory=list)


class SimClient:
    def __init__(
        self,
        cid: str,
        events: EventQueue,
        net: Network,
        rng: random.Random,
        clock_offset: list[int],
        recorder: Recorder,
        trace: list[str],
        bugs: ClientBugs,
        timeout: int,
    ) -> None:
        self.cid = cid
        self.events = events
        self.net = net
        self.rng = rng
        self.offset = clock_offset  # one-element list so the world can move it
        self.rec = recorder
        self.trace = trace
        self.bugs = bugs
        self.timeout = timeout
        self.durable = Durable()
        self.inflight: Inflight | None = None
        self.job: PullJob | None = None
        self.attempt = 0
        self.failures = 0
        self.retry_at = 0
        self.next_pull_at = 0
        self.pulls_clean = 0  # consecutive completed pulls that changed nothing (quiescence)
        self.pull_changed = False

    # --- helpers ----------------------------------------------------------------------------

    @property
    def now(self) -> int:
        return self.events.now

    def clock(self) -> int:
        return self.now + self.offset[0]

    def log(self, message: str) -> None:
        self.trace.append(f"t={self.now} {self.cid} {message}")

    def _new_key(self) -> str:
        return str(uuid.UUID(int=self.rng.getrandbits(128), version=4))

    def idle(self) -> bool:
        return not self.durable.queue and self.inflight is None and self.job is None

    # --- user actions -----------------------------------------------------------------------

    def _targets(self) -> list[str]:
        live = [i for i, e in self.durable.mirror.items() if not e.deleted]
        pending = [
            op.target
            for op in self.durable.queue
            if op.action == "create" and op.target not in self.durable.handles
        ]
        return live + pending

    def _kind_of(self, target: str) -> str:
        server_id = self.durable.handles.get(target, target)
        if server_id in self.durable.mirror:
            return self.durable.mirror[server_id].kind
        for op in self.durable.queue:
            if op.action == "create" and op.target == target:
                return op.kind
        raise KeyError(target)

    def user_action(self, kinds: tuple[str, ...]) -> None:
        rng = self.rng
        d = self.durable
        d.counter += 1
        op_id = f"{self.cid}-{d.counter}"
        roll = rng.random()
        targets = self._targets()
        deleted_tasks = [i for i, e in d.mirror.items() if e.deleted and e.kind == "task"]
        op: Op | None = None
        if roll < 0.30 or not targets:
            kind = rng.choice(kinds)
            fields = {LABEL[kind]: f"{kind}:{op_id}", "description": None}
            op = Op(
                op_id, kind, "create", f"h:{op_id}", fields, False, self._new_key(), self.clock()
            )
        elif roll < 0.72:
            target = rng.choice(targets)
            kind = self._kind_of(target)
            fields: dict[str, Any] = {}
            if rng.random() < 0.6:
                fields[LABEL[kind]] = f"{kind}:{op_id}"
            if rng.random() < 0.6 or not fields:
                fields["description"] = f"d:{op_id}"
            op = Op(
                op_id,
                kind,
                "patch",
                target,
                fields,
                rng.random() < 0.5,
                self._new_key(),
                self.clock(),
            )
        elif roll < 0.86:
            target = rng.choice(targets)
            op = Op(
                op_id,
                self._kind_of(target),
                "delete",
                target,
                {},
                False,
                self._new_key(),
                self.clock(),
            )
        elif deleted_tasks:
            target = rng.choice(deleted_tasks)
            op = Op(op_id, "task", "restore", target, {}, False, self._new_key(), self.clock())
        if op is None:
            return
        d.queue.append(op)
        if self.bugs.queue_ordered_by_client_clock:
            d.queue.sort(key=lambda o: o.ts)
        self.log(f"enqueue {op.action} {op.kind} {op.target} {op.fields} key={op.key[:8]}")

    # --- lifecycle --------------------------------------------------------------------------

    def restart(self) -> None:
        """A crash: everything volatile is lost; the durable store is what the next run sees."""
        self.log("RESTART (volatile state lost)")
        self.inflight = None
        self.job = None
        self.failures = 0
        self.retry_at = self.now
        self.next_pull_at = self.now

    # --- the driver: at most one new request per tick ---------------------------------------

    def tick(self) -> None:
        if not self.net.online.get(self.cid, True):
            return
        if self.inflight is not None:
            if self.now >= self.inflight.deadline:
                self.log(f"timeout waiting for {self.inflight.kind}")
                self._failed()
            return
        if self.now < self.retry_at:
            return
        if self.job is not None:
            self._job_step()
        elif self.now >= self.next_pull_at:
            self.job = PullJob(since=self.durable.cursor)
            self.pull_changed = False
            self._job_step()
        elif self.durable.queue:
            self._push()

    def _failed(self) -> None:
        self.inflight = None
        self.job = None  # a half-done pull is abandoned; durable state is untouched
        self.failures += 1
        base = min(20 * 2 ** min(self.failures, 5), 400)
        self.retry_at = self.now + self.rng.randint(0, base)  # full jitter

    def _send(self, kind: str, req: Req, detail: Any = None) -> None:
        self.attempt += 1
        attempt = self.attempt
        self.inflight = Inflight(attempt, kind, self.now + self.timeout, detail)
        self.net.send(self.cid, req, lambda resp: self._on_reply(attempt, resp))

    def _on_reply(self, attempt: int, resp: Resp | None) -> None:
        inflight = self.inflight
        if inflight is None or inflight.attempt != attempt:
            self.log(f"ignore late reply to attempt {attempt}")
            return
        self.inflight = None
        if resp is None or resp.status >= 500 or resp.status == 429:
            self.log(f"{inflight.kind} -> {resp.status if resp else 'lost'}; will retry")
            self._failed()
            return
        self.failures = 0
        handler = {
            "push": self._on_push,
            "feed": self._on_feed,
            "get": self._on_get,
            "list": self._on_list,
        }
        handler[inflight.kind](resp, inflight.detail)

    # --- push -------------------------------------------------------------------------------

    def _resolve(self, op: Op) -> str | None:
        return self.durable.handles.get(
            op.target, op.target if op.target in self.durable.mirror else None
        )

    def _push(self) -> None:
        d = self.durable
        op = d.queue[0]
        key = self._new_key() if (self.bugs.regen_key_on_retry and op.attempts) else op.key
        op.attempts += 1
        headers = {
            "Idempotency-Key": key,
            "X-Client-Time": str(self.clock()),
            "X-Sim-Op": op.op_id,
        }
        plural = _PLURAL[op.kind]
        if op.action == "create":
            req = Req("POST", f"/api/{plural}", body=dict(op.fields), headers=headers)
        else:
            server_id = self._resolve(op)
            if server_id is None:
                self.log(f"blocked: {op.op_id} targets unknown {op.target}")
                return
            if op.action == "patch":
                body = dict(op.fields)
                if not op.base_fixed:
                    local = d.mirror.get(server_id)
                    if op.use_base and local is not None and local.revision is not None:
                        op.base = local.revision
                    op.base_fixed = True
                if op.base is not None:
                    body["base_revision"] = op.base
                req = Req("PATCH", f"/api/{plural}/{server_id}", body=body, headers=headers)
            elif op.action == "delete":
                req = Req("DELETE", f"/api/{plural}/{server_id}", headers=headers)
            else:
                req = Req("POST", f"/api/{plural}/{server_id}/restore", headers=headers)
        self.log(f"push {op.action} {op.op_id} {req.method} {req.path}")
        self._send("push", req, detail=op)

    def _on_push(self, resp: Resp, op: Op) -> None:
        d = self.durable
        if op not in d.queue:
            return  # already settled
        if 200 <= resp.status < 300:
            self._ack(op, resp)
            return
        if (
            resp.status == 409
            and isinstance(resp.body, dict)
            and "idempotency" in str(resp.body.get("detail", ""))
        ):
            self.rec.self_inflicted.append(
                f"{op.op_id}: idempotency key reused with a different request"
            )
        self.log(f"op {op.op_id} {op.action} dropped: {resp.status}")
        self.rec.drops.append((self.cid, op, resp.status))
        d.queue.remove(op)

    def _ack(self, op: Op, resp: Resp) -> None:
        d = self.durable
        body = resp.body
        d.queue.remove(op)
        self.rec.acks.append((self.cid, op, resp.status, body))
        self.log(
            f"ACK {op.action} {op.op_id} -> {resp.status} "
            f"rev={body.get('revision') if isinstance(body, dict) else None}"
        )
        if op.action == "create":
            d.handles[op.target] = body["id"]
            d.mirror[body["id"]] = Local(op.kind, self._fields(op.kind, body), body["revision"])
        elif op.action == "delete":
            server_id = self._resolve(op)
            if server_id in d.mirror:
                d.mirror[server_id] = Local(op.kind, d.mirror[server_id].fields, None, True)
                self.rec.observations.append((self.cid, server_id, "deleted"))
        else:
            self._apply_entity(body)

    @staticmethod
    def _fields(kind: str, body: dict[str, Any]) -> dict[str, Any]:
        return {LABEL[kind]: body.get(LABEL[kind]), "description": body.get("description")}

    # --- pull -------------------------------------------------------------------------------

    def _job_step(self) -> None:
        job = self.job
        assert job is not None
        if job.stage == "feed":
            self._send("feed", Req("GET", "/api/changes", params={"since": job.since, "limit": 4}))
        elif job.stage == "get":
            if job.todo:
                kind, entity_id = job.todo[0]
                self._send(
                    "get", Req("GET", f"/api/{_PLURAL[kind]}/{entity_id}"), detail=(kind, entity_id)
                )
            else:
                self._commit_page(job)
        elif job.stage == "list":
            kind = "task" if "task" not in job.lists else "project"
            self._send("list", Req("GET", f"/api/{_PLURAL[kind]}"), detail=kind)

    def _on_feed(self, resp: Resp, _detail: Any) -> None:
        job = self.job
        if job is None or resp.status != 200:
            self.log(f"feed -> {resp.status}")
            self._failed()
            return
        page = resp.body
        if page["resync_required"]:
            self.log(f"RESYNC ({page['resync_reason']}) head={page['next_since']}")
            job.stage, job.resync_head = "list", page["next_since"]
            return
        job.page = page
        job.todo = [
            (c["entity_type"], c["entity_id"])
            for c in page["changes"]
            if c["operation"] == "upsert"
        ]
        job.stage = "get"
        if self.bugs.advance_cursor_before_apply:
            self.durable.cursor = page["next_since"]  # BUG: durable before the page is applied

    def _on_get(self, resp: Resp, detail: tuple[str, str]) -> None:
        job = self.job
        if job is None:
            return
        if resp.status == 200:
            job.fetched[detail] = resp.body
        elif resp.status == 404:
            job.fetched[detail] = None  # deleted since the page was read; its tombstone follows
        else:
            self._failed()
            return
        job.todo.pop(0)

    def _on_list(self, resp: Resp, kind: str) -> None:
        job = self.job
        if job is None or resp.status != 200:
            self._failed()
            return
        job.lists[kind] = resp.body[_PLURAL[kind]]
        if "task" in job.lists and "project" in job.lists:
            self._commit_resync(job)

    def _commit_page(self, job: PullJob) -> None:
        """The atomic step: apply the page's entities and move the cursor together."""
        d = self.durable
        page = job.page
        assert page is not None
        changed = False
        for change in page["changes"]:
            key = (change["entity_type"], change["entity_id"])
            if change["operation"] == "delete":
                if self.bugs.ignore_tombstones:
                    continue
                local = d.mirror.get(key[1])
                if local is None or not local.deleted:
                    changed = True
                d.mirror[key[1]] = Local(key[0], (local.fields if local else {}), None, True)
                self.rec.observations.append((self.cid, key[1], "deleted"))
            else:
                body = job.fetched.get(key)
                if body is None:
                    local = d.mirror.get(key[1])
                    if local is None or not local.deleted:
                        changed = True
                    d.mirror[key[1]] = Local(key[0], (local.fields if local else {}), None, True)
                    self.rec.observations.append((self.cid, key[1], "deleted"))
                else:
                    changed |= self._apply_entity(body, key[0])
        changed = changed or bool(page["changes"])
        d.cursor = page["next_since"]
        d.applied_cursor = d.cursor
        self.pull_changed |= changed
        self.log(f"applied page -> cursor {d.cursor} changed={changed}")
        if page["has_more"]:
            self.job = PullJob(since=d.cursor)
        else:
            self.job = None
            self.next_pull_at = self.now + 30 + self.rng.randint(0, 20)
            self.pulls_clean = 0 if self.pull_changed else self.pulls_clean + 1

    def _commit_resync(self, job: PullJob) -> None:
        d = self.durable
        listed: dict[str, Local] = {}
        for kind, rows in job.lists.items():
            for row in rows:
                listed[row["id"]] = Local(kind, self._fields(kind, row), row["revision"])
        for entity_id, local in list(d.mirror.items()):
            if entity_id not in listed and not local.deleted:
                d.mirror[entity_id] = Local(local.kind, local.fields, None, True)
        d.mirror.update(listed)
        d.cursor = d.applied_cursor = job.resync_head
        self.log(f"resync applied: {len(listed)} live entities, cursor {d.cursor}")
        self.job = None
        self.pull_changed = True
        self.pulls_clean = 0
        self.next_pull_at = self.now

    def _apply_entity(self, body: dict[str, Any], kind: str | None = None) -> bool:
        d = self.durable
        entity_id = body["id"]
        kind = kind or d.mirror[entity_id].kind
        local = d.mirror.get(entity_id)
        revision = body["revision"]
        if (
            local is not None
            and not local.deleted
            and local.revision is not None
            and revision < local.revision
            and not self.bugs.apply_stale_revisions
        ):
            self.log(f"skip stale {entity_id} rev {revision} < {local.revision}")
            return False
        fresh = Local(kind, self._fields(kind, body), revision)
        changed = (
            local is None
            or local.deleted
            or local.revision != revision
            or local.fields != fresh.fields
        )
        d.mirror[entity_id] = fresh
        self.rec.observations.append((self.cid, entity_id, "live"))
        return changed
