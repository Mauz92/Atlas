"""A model sync client for protocol v1 (SYNC-03; SYNC_PROTOCOL.md sections 4, 6, 7, 8).

It reuses the durable/volatile split, the fault handling and the acknowledgement rule of
:class:`~tests.sim.client.SimClient` and differs where protocol v1 does:

- every request carries ``Atlas-Sync`` (the protocol major); an unsupported major is answered
  ``426`` and the client **stops** (no retry, no write, nothing lost: its queue is kept);
- ids are chosen by the client (an offline create is addressable at once, no id mapping);
- every write carries the ``base_revision`` the user's edit was made against (the revision of the
  client's copy *when the user acted*), and a patch carries only the fields the user changed;
- a refused write is classified: ``conflict`` (same text field changed elsewhere) and ``edit_wins``
  (the entity was edited after the delete was based) are the *expected* refusals; anything else is
  a harness failure (``unexpected_rejection``);
- the pull is ``GET /api/changes?include=data&types=task,project``: the entities arrive in the
  page, so there is no per-entity read except to re-read an acknowledged entity;
- ``resync_required`` is handled as SYNC_PROTOCOL.md 7.3: walk a fresh snapshot from cursor 0 into
  a shadow copy, then replace the mirror and set the cursor to the head, in one step.
"""

from __future__ import annotations

from dataclasses import replace
from typing import Any

from .client import Local, Op, PullJob, SimClient
from .engine import Req, Resp
from .model import FLAG, FLAG_VALUES, LABEL

_PLURAL = {"task": "tasks", "project": "projects"}
_EXPECTED_REFUSALS = {"conflict", "edit_wins"}


class SyncSimClient(SimClient):
    protocol = 1

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.halted = False
        self.sent = 0
        self.sent_at_halt = -1
        self.active = True

    # --- lifecycle --------------------------------------------------------------------------

    def idle(self) -> bool:
        return self.halted or super().idle()

    def tick(self) -> None:
        if self.halted:
            return
        super().tick()

    def _send(self, kind: str, req: Req, detail: Any = None) -> None:
        self.sent += 1
        headers = {**req.headers, "Atlas-Sync": str(self.protocol)}
        super()._send(kind, replace(req, headers=headers), detail)

    def _on_reply(self, attempt: int, resp: Resp | None) -> None:
        inflight = self.inflight
        if (
            resp is not None
            and resp.status == 426
            and inflight is not None
            and inflight.attempt == attempt
            and not self.bugs.ignore_426
        ):
            self.inflight = None
            self.job = None
            self.halted = True
            self.sent_at_halt = self.sent
            self.log("426 sync_version_unsupported: stop syncing, keep the queue, tell the user")
            self.rec.halts.append(self.cid)
            return
        super()._on_reply(attempt, resp)

    # --- user actions -----------------------------------------------------------------------

    def _base_for(self, target: str) -> int:
        """The revision of the client's copy of ``target`` when the user acts (1 for an entity it
        created itself and has not seen acknowledged: the local copy starts at revision 1)."""
        local = self.durable.mirror.get(target)
        return local.revision if local is not None and local.revision is not None else 1

    def user_action(self, kinds: tuple[str, ...]) -> None:
        if not self.active:
            return
        rng, d = self.rng, self.durable
        d.counter += 1
        op_id = f"{self.cid}-{d.counter}"
        roll = rng.random()
        targets = self._targets()
        deleted_tasks = [i for i, e in d.mirror.items() if e.deleted and e.kind == "task"]
        op: Op | None = None
        if roll < 0.30 or not targets:
            kind = rng.choice(kinds)
            fields: dict[str, Any] = {LABEL[kind]: f"{kind}:{op_id}", "description": None}
            if rng.random() < 0.4:
                fields[FLAG[kind]] = rng.choice(FLAG_VALUES[kind])
            new_id = self._new_key()  # a client-chosen id: a UUID drawn from the seeded stream
            op = Op(op_id, kind, "create", new_id, fields, False, self._new_key(), self.clock())
        elif roll < 0.76:
            target = rng.choice(targets)
            kind = self._kind_of(target)
            changed: dict[str, Any] = {}
            if rng.random() < 0.5:
                changed[LABEL[kind]] = f"{kind}:{op_id}"
            if rng.random() < 0.4:
                changed["description"] = f"d:{op_id}"
            if rng.random() < 0.5 or not changed:
                changed[FLAG[kind]] = rng.choice(FLAG_VALUES[kind])
            op = Op(op_id, kind, "patch", target, changed, True, self._new_key(), self.clock())
            op.base, op.base_fixed = self._base_for(target), True
        elif roll < 0.90:
            target = rng.choice(targets)
            op = Op(
                op_id, self._kind_of(target), "delete", target, {}, False, self._new_key(),
                self.clock(),
            )  # fmt: skip
            op.base, op.base_fixed = self._base_for(target), True
        elif deleted_tasks:
            target = rng.choice(deleted_tasks)
            op = Op(op_id, "task", "restore", target, {}, False, self._new_key(), self.clock())
        if op is None:
            return
        d.queue.append(op)
        if self.bugs.queue_ordered_by_client_clock:
            d.queue.sort(key=lambda o: o.ts)
        self.log(f"enqueue {op.action} {op.kind} {op.target} {op.fields} base={op.base}")

    # --- push -------------------------------------------------------------------------------

    def _resolve(self, op: Op) -> str | None:
        return op.target  # ids are the client's own

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
            req = Req(
                "POST", f"/api/{plural}", body={"id": op.target, **op.fields}, headers=headers
            )
        elif op.action == "patch":
            body = {**op.fields, "base_revision": op.base}
            req = Req("PATCH", f"/api/{plural}/{op.target}", body=body, headers=headers)
        elif op.action == "delete":
            req = Req(
                "DELETE",
                f"/api/{plural}/{op.target}",
                params={"base_revision": op.base},
                headers=headers,
            )
        else:
            req = Req("POST", f"/api/{plural}/{op.target}/restore", headers=headers)
        self.log(f"push {op.action} {op.op_id} {req.method} {req.path}")
        self._send("push", req, detail=op)

    def _on_push(self, resp: Resp, op: Op) -> None:
        d = self.durable
        if op not in d.queue:
            return
        if 200 <= resp.status < 300:
            self._ack(op, resp)
            return
        code = resp.body.get("error") if isinstance(resp.body, dict) else None
        if code == "idempotency_mismatch":
            self.rec.self_inflicted.append(
                f"{op.op_id}: idempotency key reused with a different request"
            )
        self.log(f"op {op.op_id} {op.action} refused: {resp.status} {code}")
        self.rec.drops.append((self.cid, op, resp.status))
        self.rec.refusals.append((self.cid, op, resp.status, code))
        d.queue.remove(op)

    # --- pull -------------------------------------------------------------------------------

    def _job_step(self) -> None:
        job = self.job
        assert job is not None
        if job.stage == "feed":
            params: dict[str, Any] = {
                "since": job.since,
                "limit": 4,
                "include": "data",
                "types": "task,project",
            }
            if job.shadow is not None and job.since > 0:
                params["snapshot"] = True  # a continuation of the snapshot walk (never below floor)
            self._send("feed", Req("GET", "/api/changes", params=params))
        else:
            super()._job_step()

    def _on_feed(self, resp: Resp, _detail: Any) -> None:
        job = self.job
        if job is None or resp.status != 200:
            self.log(f"feed -> {resp.status}")
            self._failed()
            return
        page = resp.body
        if page["resync_required"]:
            self.log(f"RESYNC ({page['resync_reason']}): walk a snapshot from 0 into a shadow copy")
            self.job = PullJob(since=0, shadow={})
            return
        job.page = page
        job.refetch = {
            i: k
            for i, k in self.durable.refetch.items()
            if i not in {c["entity_id"] for c in page["changes"]}
        }
        job.todo = [(kind, entity_id) for entity_id, kind in job.refetch.items()]
        job.stage = "get"
        if self.bugs.advance_cursor_before_apply:
            self.durable.cursor = page["next_since"]  # BUG: durable before the page is applied

    def _commit_page(self, job: PullJob) -> None:
        d = self.durable
        page = job.page
        assert page is not None
        if job.shadow is not None:
            self._shadow_page(job, page)
            return
        changed = False
        for entity_id, kind in job.refetch.items():
            body = job.fetched.get((kind, entity_id))
            local = d.mirror.get(entity_id)
            if body is None:
                if local is None or not local.deleted:
                    changed = True
                d.mirror[entity_id] = Local(kind, (local.fields if local else {}), None, True)
                self.rec.observations.append((self.cid, entity_id, "deleted"))
            else:
                changed |= self._apply_entity(body, kind)
            d.refetch.pop(entity_id, None)
        refreshed = set(job.refetch)
        for change in page["changes"]:
            entity_id, kind = change["entity_id"], change["entity_type"]
            if entity_id in refreshed:
                continue
            data = change.get("data")
            gone = change["operation"] == "delete" or data is None or data["deleted_at"]
            if gone:
                if self.bugs.ignore_tombstones:
                    continue
                local = d.mirror.get(entity_id)
                if local is None or not local.deleted:
                    changed = True
                d.mirror[entity_id] = Local(kind, (local.fields if local else {}), None, True)
                self.rec.observations.append((self.cid, entity_id, "deleted"))
            else:
                changed |= self._apply_entity(data, kind)
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

    def _shadow_page(self, job: PullJob, page: dict[str, Any]) -> None:
        """One page of the snapshot walk; at the end, replace the mirror and move the cursor."""
        d = self.durable
        shadow = job.shadow
        assert shadow is not None
        for change in page["changes"]:
            data = change.get("data")
            gone = change["operation"] == "delete" or data is None or data["deleted_at"]
            if gone:
                shadow[change["entity_id"]] = (change["entity_type"], None)
            else:
                shadow[change["entity_id"]] = (change["entity_type"], data)
        if page["has_more"]:
            self.job = PullJob(since=page["next_since"], shadow=shadow)
            return
        for entity_id, (kind, data) in shadow.items():
            if data is None:
                # Remember the tombstone even for an id never held: a create of it may still be
                # in flight and its acknowledgement must not bring the entity back (seed 681).
                local = d.mirror.get(entity_id)
                if local is None or not local.deleted:
                    d.mirror[entity_id] = Local(kind, local.fields if local else {}, None, True)
                    self.rec.observations.append((self.cid, entity_id, "deleted"))
            else:
                self._apply_entity(data, kind)
        for entity_id, local in list(d.mirror.items()):
            if entity_id not in shadow and not local.deleted:
                # absent from the snapshot: deleted while the client was away (it has no pending
                # edit in this model; a pending edit would revive it when pushed, rule 4)
                d.mirror[entity_id] = Local(local.kind, local.fields, None, True)
        d.refetch.clear()
        d.cursor = d.applied_cursor = page["next_since"]
        self.log(f"snapshot applied: {len(shadow)} entities, cursor {d.cursor}")
        self.job = None
        self.pull_changed = True
        self.pulls_clean = 0
        self.next_pull_at = self.now
