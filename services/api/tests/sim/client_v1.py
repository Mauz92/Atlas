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
from .model_notes import sha

_PLURAL = {"task": "tasks", "project": "projects", "note": "notes"}
_EXPECTED_REFUSALS = {"conflict", "edit_wins", "path_exists", "note_deleted"}
#: a small pool, so creates and moves collide (also by letter case)
_NOTE_PATHS = ("a.md", "A.md", "b.md", "dir/a.md", "dir/A.md", "dir/b.md", "c d.md")


def markers(text: str) -> frozenset[str]:
    """The simulation writes unique ``m:...`` lines; they identify what an edit added or removed."""
    return frozenset(line for line in text.split("\n") if line.startswith("m:"))


class SyncSimClient(SimClient):
    protocol = 1

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.halted = False
        self.sent = 0
        self.sent_at_halt = -1
        self.active = True
        #: SYNC-05: pull the ``resolution`` entity and undo resolutions (set by the world)
        self.track_resolutions = False

    # --- lifecycle --------------------------------------------------------------------------

    def idle(self) -> bool:
        return self.halted or (super().idle() and self._unhydrated() is None)

    # --- note content (the feed carries a note's metadata only) -------------------------------

    def _unhydrated(self) -> str | None:
        wanted = sorted(
            i
            for i, e in self.durable.mirror.items()
            if e.kind == "note" and not e.deleted and e.fields.get("content") is None
        )
        return wanted[0] if wanted else None

    def _extra_handlers(self) -> dict[str, Any]:
        return {"hydrate": self._on_hydrate}

    def _background(self) -> bool:
        note_id = self._unhydrated()
        if note_id is None or self.halted:
            return False
        self._send("hydrate", Req("GET", f"/api/notes/{note_id}"), detail=note_id)
        return True

    def _on_hydrate(self, resp: Resp, note_id: str) -> None:
        if resp.status == 200:
            self._apply_entity(resp.body, "note")
        elif resp.status == 404:
            local = self.durable.mirror.get(note_id)
            if local is not None and not local.deleted:
                self.durable.mirror[note_id] = Local("note", local.fields, None, True)
                self.rec.observations.append((self.cid, note_id, "deleted"))
        else:
            self._failed()

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
        if (
            resp is not None
            and resp.status == 401
            and isinstance(resp.body, dict)
            and resp.body.get("error") == "token_revoked"
            and inflight is not None
            and inflight.attempt == attempt
            and not self.bugs.ignore_revoked
        ):
            # SYNC_PROTOCOL.md 8.1: stop, keep the queue and the local data, ask the user to sign in
            self.inflight = None
            self.job = None
            self.halted = True
            self.sent_at_halt = self.sent
            self.log("401 token_revoked: stop syncing, keep the queue, ask the user to sign in")
            self.rec.revoked_halts.append(self.cid)
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
        if self.track_resolutions and self._undo_action(op_id):
            return
        if "note" in kinds and rng.random() < (1.0 if kinds == ("note",) else 0.4):
            self._note_action(op_id)
            return
        roll = rng.random()
        targets = self._targets()
        deleted_tasks = [i for i, e in d.mirror.items() if e.deleted and e.kind == "task"]
        op: Op | None = None
        if roll < 0.30 or not targets:
            kind = rng.choice([k for k in kinds if k != "note"] or kinds)
            fields: dict[str, Any] = {LABEL[kind]: f"{kind}:{op_id}", "description": None}
            if rng.random() < 0.4:
                fields[FLAG[kind]] = rng.choice(FLAG_VALUES[kind])
            new_id = self._new_key()  # a client-chosen id: a UUID drawn from the seeded stream
            op = Op(op_id, kind, "create", new_id, fields, False, self._new_key(), self.clock())
        elif roll < 0.76:
            target = rng.choice(targets)
            kind = self._kind_of(target)
            if kind == "note":
                self._note_edit_or_move(target, op_id, move=False)
                return
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

    def undo_tap(self) -> None:
        """The user taps undo on a notice they hold (the second wave of a resolution run)."""
        self.durable.counter += 1
        self._undo_action(f"{self.cid}-{self.durable.counter}", force=True)

    def _undo_action(self, op_id: str, *, force: bool = False) -> bool:
        """The user taps "undo" on a "changed on another device" notice (SYNC-05). Mostly an
        undoable one; sometimes any notice, so the refusals (already undone, not undoable) are
        exercised too."""
        rng, d = self.rng, self.durable
        queued = {o.target for o in d.queue if o.action == "undo"}
        known = [
            i for i in d.resolutions if i not in queued
        ]  # in the order the client learned them
        undoable = [i for i in known if d.resolutions[i]["undoable"]]
        if not known or rng.random() >= (0.7 if undoable or force else 0.1):
            return False
        pool = known if (not undoable or rng.random() < 0.2) else undoable
        # a user taps the notice that just appeared far more often than an old one
        target = pool[-1] if rng.random() < 0.7 else rng.choice(pool)
        op = Op(op_id, "resolution", "undo", target, {}, False, self._new_key(), self.clock())
        # an undo is a tap on a notice, not part of the user's edit stream: it goes in front of the
        # unsent operations (never in front of one already sent, whose retry must stay identical)
        d.queue.insert(1 if d.queue and d.queue[0].attempts else 0, op)
        self.log(f"enqueue undo of resolution {target}")
        return True

    # --- note actions -------------------------------------------------------------------------

    def _pending_create(self, target: str) -> Op | None:
        return next(
            (o for o in self.durable.queue if o.action == "create" and o.target == target), None
        )

    def _note_create(self, op_id: str) -> None:
        rng, d = self.rng, self.durable
        count = rng.randint(10, 25)
        lines = [f"m:{self.cid}-{d.counter}.{k}" for k in range(count)]
        text = "\n".join(lines) + ("\n" if rng.random() < 0.7 else "")
        fields = {"path": rng.choice(_NOTE_PATHS), "content": text}
        op = Op(
            op_id, "note", "create", self._new_key(), fields, False, self._new_key(), self.clock()
        )
        op.markers = markers(text)
        d.queue.append(op)
        self.log(f"enqueue create note {op.target} {fields['path']}")

    def _edited(self, text: str) -> str:
        """One user edit of ``text``: insert, replace or delete a line (unique marker lines)."""
        rng, d = self.rng, self.durable
        d.counter += 1
        marker = f"m:{self.cid}-{d.counter}"
        final_newline = text.endswith("\n")
        body = text.split("\n")[: -1 if final_newline else None] if text else []
        roll = rng.random()
        if roll < 0.7 or not body:
            body.insert(rng.randint(0, len(body)), marker)
        elif roll < 0.85:
            body[rng.randrange(len(body))] = marker
        else:
            del body[rng.randrange(len(body))]
        return "\n".join(body) + ("\n" if final_newline and body else "")

    def _note_action(self, op_id: str) -> None:
        """One user action on notes: mostly edits, some moves and deletes, creates while few."""
        rng, d = self.rng, self.durable
        notes = [t for t in self._targets() if self._kind_of(t) == "note"]
        roll = rng.random()
        if not notes or (len(notes) < 4 and roll < 0.25) or roll < 0.04:
            self._note_create(op_id)
        elif roll < 0.78:
            self._note_edit_or_move(rng.choice(notes), op_id, move=False)
        elif roll < 0.94:
            self._note_edit_or_move(rng.choice(notes), op_id, move=True)
        else:
            target = rng.choice(notes)
            op = Op(op_id, "note", "delete", target, {}, False, self._new_key(), self.clock())
            op.base, op.base_fixed = self._base_for(target), True
            d.queue.append(op)
            self.log(f"enqueue delete note {target} base={op.base}")

    def _note_edit_or_move(self, target: str, op_id: str, *, move: bool) -> None:
        rng, d = self.rng, self.durable
        pending = self._pending_create(target)
        if pending is not None:
            if pending.attempts:  # in flight: its text is fixed
                return
            if move:
                pending.fields["path"] = rng.choice(_NOTE_PATHS)
            else:
                pending.fields["content"] = self._edited(pending.fields["content"])
                pending.markers = markers(pending.fields["content"])
            self.log(f"edit pending create {target}")
            return
        local = d.mirror.get(target)
        if local is None or local.deleted or local.revision is None:
            return
        if move:
            op = Op(op_id, "note", "move", target, {"path": rng.choice(_NOTE_PATHS)}, True,
                    self._new_key(), self.clock())  # fmt: skip
            op.base, op.base_fixed = local.revision, True
            d.queue.append(op)
            self.log(f"enqueue move {target} -> {op.fields['path']} base={op.base}")
            return
        queued = next((o for o in d.queue if o.action == "put" and o.target == target), None)
        if queued is not None:
            if queued.attempts:  # sent: the text is frozen until it is answered
                return
            text, base_rev, base_hash, base_text = d.working[target]
            d.working[target] = (self._edited(text), base_rev, base_hash, base_text)
            self.log(f"edit queued save of {target}")
            return
        content = local.fields.get("content")
        if content is None or local.chash is None:
            return  # not downloaded yet: nothing to edit
        d.working[target] = (self._edited(content), local.revision, local.chash, content)
        op = Op(op_id, "note", "put", target, {}, True, self._new_key(), self.clock())
        d.queue.append(op)
        self.log(f"enqueue edit of {target} based on revision {local.revision}")

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
        plural = _PLURAL.get(op.kind, "")
        if op.action == "undo":
            req = Req("POST", f"/api/sync/resolutions/{op.target}/undo", headers=headers)
        elif op.kind == "note" and op.action == "put":
            if not op.base_fixed and op.target not in d.working:
                d.queue.remove(op)  # nothing to save any more
                return
            if not op.base_fixed:
                text, base_rev, base_hash, base_text = d.working[op.target]
                op.fields = {"content": text}
                op.base, op.base_hash, op.base_fixed = base_rev, base_hash, True
                op.markers = markers(text) - markers(base_text)
                op.removed = markers(base_text) - markers(text)
            body = {**op.fields, "base_revision": op.base, "base_hash": op.base_hash}
            req = Req("PUT", f"/api/notes/{op.target}", body=body, headers=headers)
        elif op.kind == "note" and op.action == "move":
            body = {**op.fields, "base_revision": op.base}
            req = Req("POST", f"/api/notes/{op.target}/move", body=body, headers=headers)
        elif op.action == "create":
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
        self._note_resolutions(op, resp)
        if op.action == "undo":
            self._on_undo(resp, op)
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
        if op.kind == "note" and op.action == "put":
            # The edit was not applied; on a conflict its text is in the copy the server saved.
            d.working.pop(op.target, None)
            copy = resp.body.get("conflict_copy") if isinstance(resp.body, dict) else None
            if copy is not None:
                self.rec.conflict_copies.append((self.cid, op, copy))
            self.pull_changed = True

    def _note_resolutions(self, op: Op, resp: Resp) -> None:
        """Remember every resolution a response told this client about, and the value a winning
        write stored (what an undo must later find in place of the value it replaces)."""
        body = resp.body
        if not isinstance(body, dict):
            return
        outs: list[dict[str, Any]] = []
        sync = body.get("sync")
        if isinstance(sync, dict):
            outs += sync.get("resolution", [])
        if isinstance(body.get("resolution"), list):
            outs += body["resolution"]
        for out in outs:
            if out.get("id"):
                self.rec.seen_resolutions[out["id"]] = (op.op_id, out)
                if (
                    200 <= resp.status < 300
                    and out["rule"] in ("simple_later_wins", "path_later_wins")
                    and out.get("field")
                ):
                    self.rec.winners[out["id"]] = body.get(out["field"])

    def _on_undo(self, resp: Resp, op: Op) -> None:
        """An answer to an undo: settled either way (a refusal is not retried)."""
        d = self.durable
        d.queue.remove(op)
        body = resp.body
        if 200 <= resp.status < 300 and isinstance(body, dict):
            self.rec.undos.append((self.cid, op, resp.status, body))
            entry = body["undo"]
            if entry.get("id"):
                self.rec.seen_resolutions[entry["id"]] = (op.op_id, entry)
            ref = body["resolution"]
            # the undo changed the entity: read it again at the next pull (an answer is historical)
            d.refetch[ref["entity_id"]] = ref["entity_type"]
            self.log(f"ACK undo {op.op_id} -> applied={body['applied']}")
            return
        code = body.get("error") if isinstance(body, dict) else None
        self.rec.undo_refusals.append((self.cid, op, resp.status, code))
        self.log(f"undo {op.op_id} refused: {resp.status} {code}")
        self.pull_changed = True

    def _ack(self, op: Op, resp: Resp) -> None:
        super()._ack(op, resp)
        if op.kind == "note" and op.action == "put":
            self.durable.working.pop(op.target, None)
            if isinstance(resp.body, dict) and resp.body.get("conflict_copy"):
                raise AssertionError("a conflict is never a 2xx")

    def _apply_ack(self, body: dict[str, Any], kind: str) -> None:
        if kind != "note":
            super()._apply_ack(body, kind)
            return
        d = self.durable
        entity_id = body["id"]
        local = d.mirror.get(entity_id)
        if local is None:
            fields = {"path": body["path"], "content": body.get("content")}
            d.mirror[entity_id] = Local(
                "note", fields, body["revision"], False, body.get("content_hash")
            )
            self.rec.observations.append((self.cid, entity_id, "live"))
        elif not local.deleted:
            self._apply_entity(body, kind)
        d.refetch[entity_id] = kind

    def _apply_entity(self, body: dict[str, Any], kind: str | None = None) -> bool:
        d = self.durable
        kind = kind or d.mirror[body["id"]].kind
        if kind != "note":
            return super()._apply_entity(body, kind)
        local = d.mirror.get(body["id"])
        revision = body["revision"]
        if (
            local is not None
            and not local.deleted
            and local.revision is not None
            and revision < local.revision
            and not self.bugs.apply_stale_revisions
        ):
            return False
        chash = body.get("content_hash")
        content = body.get("content")
        if content is None and local is not None and not local.deleted and local.chash == chash:
            content = local.fields.get("content")  # the feed carries metadata only
        if content is not None and chash is not None and sha(content) != chash:
            raise AssertionError(f"note {body['id']}: body and hash disagree")
        fresh = Local("note", {"path": body["path"], "content": content}, revision, False, chash)
        changed = (
            local is None
            or local.deleted
            or local.revision != revision
            or local.fields != fresh.fields
        )
        d.mirror[body["id"]] = fresh
        self.rec.observations.append((self.cid, body["id"], "live"))
        return changed

    # --- pull -------------------------------------------------------------------------------

    def _job_step(self) -> None:
        job = self.job
        assert job is not None
        if job.stage == "feed":
            params: dict[str, Any] = {
                "since": job.since,
                "limit": 4,
                "include": "data",
                "types": "task,project,note,resolution"
                if self.track_resolutions
                else "task,project,note",
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
            if kind == "resolution":
                if change.get("data") is not None:
                    d.resolutions[entity_id] = change["data"]
                continue
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
            if change["entity_type"] == "resolution":
                shadow[change["entity_id"]] = ("resolution", data)
                continue
            gone = change["operation"] == "delete" or data is None or data["deleted_at"]
            if gone:
                shadow[change["entity_id"]] = (change["entity_type"], None)
            else:
                shadow[change["entity_id"]] = (change["entity_type"], data)
        if page["has_more"]:
            self.job = PullJob(since=page["next_since"], shadow=shadow)
            return
        # the snapshot is the whole truth about the notices too
        d.resolutions = {
            i: data for i, (kind, data) in shadow.items() if kind == "resolution" and data
        }
        for entity_id, (kind, data) in shadow.items():
            if kind == "resolution":
                continue
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
