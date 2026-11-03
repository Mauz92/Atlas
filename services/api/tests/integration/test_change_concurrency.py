"""The change-feed cursor under concurrent writers (SYNC-01 c) against a real PostgreSQL.

``ChangeRecorder`` allocates a cursor with ``UPDATE users SET change_seq = change_seq + 1 …
RETURNING``. That statement takes the user's row lock, which is held until the transaction ends, so
two same-user writers can never both hold an allocated-but-uncommitted cursor: the later one blocks
until the earlier commits (or rolls back, which also rolls the counter back). The consequence the
feed relies on is *commit order = cursor order, gap-free*, so a reader that has seen cursor ``k``
can never later see a change at a cursor ``<= k``.

These tests prove that with real concurrent transactions rather than by reading the code:

- deterministic interleavings controlled by events (not sleeps), including the blocking itself,
  observed in ``pg_stat_activity``;
- a seeded stress run with a concurrent reader that pages the feed while writers commit and roll
  back;
- a **negative control**: the classic broken design (cursor handed out in its own short transaction)
  does let the same reader skip a change, which shows the checker can fail.
"""

from __future__ import annotations

import asyncio
import contextlib
import random
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable

import pytest
from sqlalchemy import select, text

from atlas.changes import ChangeEntityType, ChangeOperation, ChangeRecorder, ChangesService
from atlas.db import session_scope
from atlas.models import ChangeLog, User

pytestmark = pytest.mark.usefixtures("_db")

_TIMEOUT = 5.0


async def _owner() -> uuid.UUID:
    async with session_scope() as session:
        user = User(
            email=f"{uuid.uuid4().hex}@example.com", display_name="Owner", password_hash="x"
        )
        session.add(user)
        await session.flush()
        return user.id


async def _pull(
    owner: uuid.UUID, since: int, limit: int = 500
) -> tuple[list[tuple[str, int]], int]:
    """One feed page as ``([(entity_id, cursor)], next_since)``."""
    async with session_scope() as session:
        page = await ChangesService(session, owner).changes(since=since, limit=limit)
    assert not page.resync_required
    return [(change.entity_id, change.cursor) for change in page.changes], page.next_since


async def _wait_until(predicate: Callable[[], Awaitable[bool]]) -> None:
    async with asyncio.timeout(_TIMEOUT):
        while not await predicate():
            await asyncio.sleep(0.005)


async def _writers_blocked_on_the_cursor() -> int:
    """How many backends are waiting for a lock inside the cursor-allocating UPDATE."""
    async with session_scope() as session:
        result = await session.execute(
            text(
                "SELECT count(*) FROM pg_stat_activity "
                "WHERE datname = current_database() AND wait_event_type = 'Lock' "
                "AND query LIKE 'UPDATE users SET change_seq%'"
            )
        )
        return int(result.scalar_one())


_ACTIVE: list[list[_Writer]] = []


class _Writer:
    """One same-user transaction that records one entity and then waits to be told to finish."""

    def __init__(
        self,
        owner: uuid.UUID,
        recorder_type: type[ChangeRecorder] = ChangeRecorder,
        *,
        commit: bool = True,
    ) -> None:
        self.owner = owner
        self.entity_id = str(uuid.uuid4())
        self.seq: int | None = None
        self.recorded = asyncio.Event()
        self.release = asyncio.Event()
        self.finished = asyncio.Event()
        self._recorder_type = recorder_type
        self._commit = commit
        self.task = asyncio.create_task(self._run())
        if _ACTIVE:
            _ACTIVE[-1].append(self)

    async def _run(self) -> None:
        try:
            async with session_scope() as session:
                recorder = self._recorder_type(session, self.owner)
                self.seq = await recorder.record(
                    ChangeEntityType.TASK, self.entity_id, ChangeOperation.UPSERT
                )
                self.recorded.set()
                await self.release.wait()
                if not self._commit:
                    await session.rollback()
        finally:
            self.finished.set()

    async def wait_recorded(self) -> None:
        async with asyncio.timeout(_TIMEOUT):
            await self.recorded.wait()

    async def finish(self) -> None:
        self.release.set()
        async with asyncio.timeout(_TIMEOUT):
            await self.task


@contextlib.asynccontextmanager
async def _open_writers() -> AsyncIterator[list[_Writer]]:
    """Track writers so a failing assertion cannot leave transactions holding the user's lock."""
    writers: list[_Writer] = []
    _ACTIVE.append(writers)
    try:
        yield writers
    finally:
        _ACTIVE.pop()
        for writer in writers:
            writer.release.set()
        async with asyncio.timeout(_TIMEOUT):
            await asyncio.gather(*(w.task for w in writers), return_exceptions=True)


@pytest.fixture(autouse=True)
async def _no_leaked_writers(_db: None) -> AsyncIterator[None]:
    """Torn down before ``_db``: a failing test must not leave transactions holding row locks."""
    async with _open_writers():
        yield


# --- deterministic interleavings ---------------------------------------------------------------


async def test_a_second_writer_blocks_until_the_first_commits_and_gets_the_higher_cursor() -> None:
    owner = await _owner()
    first = _Writer(owner)
    await first.wait_recorded()
    second = _Writer(owner)

    # B is genuinely blocked on A's row lock (not merely slow): observed in the server.
    await _wait_until(lambda: _is_blocked(1))
    assert not second.recorded.is_set()
    assert first.seq == 1

    # Nothing is committed yet, so a reader sees nothing: no half-visible cursor.
    assert await _pull(owner, 0) == ([], 0)

    await first.finish()
    await second.wait_recorded()
    assert second.seq == 2  # allocated only after A's commit, so strictly higher

    # A is visible; B (allocated, uncommitted) is not, and cannot become visible before A was.
    visible, cursor = await _pull(owner, 0)
    assert visible == [(first.entity_id, 1)]
    assert cursor == 1

    await second.finish()
    later, cursor = await _pull(owner, cursor)
    assert later == [(second.entity_id, 2)]
    assert cursor == 2


async def _is_blocked(count: int) -> bool:
    return await _writers_blocked_on_the_cursor() >= count


async def test_a_rolled_back_writer_leaves_no_gap() -> None:
    owner = await _owner()
    doomed = _Writer(owner, commit=False)
    await doomed.wait_recorded()
    survivor = _Writer(owner)
    await _wait_until(lambda: _is_blocked(1))

    await doomed.finish()  # rolls back: the counter is rolled back with it
    await survivor.wait_recorded()
    assert doomed.seq == 1
    assert survivor.seq == 1  # reuses the cursor: the sequence stays gap-free
    await survivor.finish()

    assert await _pull(owner, 0) == ([(survivor.entity_id, 1)], 1)
    async with session_scope() as session:
        assert await session.scalar(select(User.change_seq).where(User.id == owner)) == 1


async def test_many_blocked_writers_are_released_one_at_a_time_in_commit_order() -> None:
    owner = await _owner()
    first = _Writer(owner)
    await first.wait_recorded()
    waiting = [_Writer(owner) for _ in range(4)]
    await _wait_until(lambda: _is_blocked(4))

    committed_order: list[_Writer] = [first]
    await first.finish()
    remaining = list(waiting)
    while remaining:
        # Exactly one of the blocked writers gets through (which one is the lock manager's choice);
        # the others stay blocked until it ends.
        async def _one_through(candidates: list[_Writer] = remaining) -> bool:
            return any(w.recorded.is_set() for w in candidates)

        await _wait_until(_one_through)
        through = [w for w in remaining if w.recorded.is_set()]
        assert len(through) == 1
        committed_order.append(through[0])
        remaining.remove(through[0])
        await through[0].finish()

    # The cursor each writer received is its position in commit order: no ties, no gaps.
    assert [w.seq for w in committed_order] == [1, 2, 3, 4, 5]
    visible, cursor = await _pull(owner, 0)
    assert visible == [(w.entity_id, w.seq) for w in committed_order]
    assert cursor == 5


async def test_writers_of_different_users_do_not_block_each_other() -> None:
    first_owner, second_owner = await _owner(), await _owner()
    first = _Writer(first_owner)
    await first.wait_recorded()
    second = _Writer(second_owner)
    await second.wait_recorded()  # would time out if it queued behind the other user's lock
    assert first.seq == second.seq == 1
    await first.finish()
    await second.finish()


# --- negative control: the checker can fail ----------------------------------------------------


class _OutOfBandRecorder(ChangeRecorder):
    """The classic broken design: the cursor is handed out in its *own* short transaction.

    Used only to show that the reader check below detects a skipped change; it is never used by
    application code.
    """

    async def _advance_cursor(self) -> int:
        async with session_scope() as other:
            result = await other.execute(
                text(
                    "UPDATE users SET change_seq = change_seq + 1 "
                    "WHERE id = :user_id RETURNING change_seq"
                ),
                {"user_id": self.user_id},
            )
            return int(result.scalar_one())


async def test_negative_control_an_out_of_band_cursor_lets_a_reader_skip_a_change() -> None:
    owner = await _owner()
    slow = _Writer(owner, _OutOfBandRecorder)
    await slow.wait_recorded()  # holds cursor 1, uncommitted
    fast = _Writer(owner, _OutOfBandRecorder)
    await fast.wait_recorded()  # not blocked: takes cursor 2
    assert (slow.seq, fast.seq) == (1, 2)
    await fast.finish()  # 2 commits before 1

    seen, cursor = await _pull(owner, 0)
    assert seen == [(fast.entity_id, 2)] and cursor == 2

    await slow.finish()  # 1 commits after the reader moved past it
    later, _ = await _pull(owner, cursor)
    assert later == []  # the change at cursor 1 is lost to this reader: the failure we detect
    async with session_scope() as session:
        assert await session.scalar(
            select(ChangeLog.seq).where(ChangeLog.entity_id == slow.entity_id)
        )


# --- seeded stress with a concurrent reader ----------------------------------------------------


@pytest.mark.parametrize("seed", [1, 2, 3])
async def test_concurrent_writers_and_a_paging_reader_never_skip_a_change(seed: int) -> None:
    rng = random.Random(seed)
    owner = await _owner()
    writers = 8
    per_writer = 3
    committed: dict[str, int] = {}  # entity_id -> cursor, for transactions that committed
    rolled_back: set[str] = set()
    done = asyncio.Event()

    plans = [
        (
            [rng.random() * 0.01 for _ in range(per_writer + 1)],
            rng.random() < 0.25,  # roll this writer back
        )
        for _ in range(writers)
    ]

    async def write(index: int) -> None:
        delays, rollback = plans[index]
        entities: list[str] = []
        async with session_scope() as session:
            recorder = ChangeRecorder(session, owner)
            seqs: list[int] = []
            for n in range(per_writer):
                await asyncio.sleep(delays[n])
                entity_id = f"{index}-{n}-{uuid.uuid4()}"
                entities.append(entity_id)
                seqs.append(
                    await recorder.record(ChangeEntityType.TASK, entity_id, ChangeOperation.UPSERT)
                )
            assert seqs == list(range(seqs[0], seqs[0] + per_writer)), (
                "one writer's run is contiguous"
            )
            await asyncio.sleep(delays[-1])
            if rollback:
                await session.rollback()
        if rollback:
            rolled_back.update(entities)
        else:
            committed.update(zip(entities, seqs, strict=True))

    async def read() -> list[tuple[str, int]]:
        collected: list[tuple[str, int]] = []
        since = 0
        while True:
            # Sample "writers finished" *before* the pull: only an empty page read after every
            # writer has ended proves the reader has caught up.
            writers_finished = done.is_set()
            page_size = rng.choice([1, 2, 5])
            page, next_since = await _pull(owner, since, limit=page_size)
            for _, cursor in page:
                assert cursor > since, "a page never repeats or goes backwards"
            collected.extend(page)
            since = next_since
            if writers_finished and not page:
                return collected
            await asyncio.sleep(0)

    reader = asyncio.create_task(read())
    async with asyncio.timeout(_TIMEOUT * 2):
        await asyncio.gather(*(write(i) for i in range(writers)))
    done.set()
    seen = await asyncio.wait_for(reader, _TIMEOUT)

    seen_ids = [entity_id for entity_id, _ in seen]
    assert len(seen_ids) == len(set(seen_ids)), "no change delivered twice"
    assert set(seen_ids) == set(committed), "the reader skipped nothing that committed"
    assert not rolled_back & set(seen_ids), "a rolled-back change is never announced"
    cursors = [cursor for _, cursor in seen]
    assert cursors == sorted(cursors) and len(set(cursors)) == len(cursors)
    assert cursors == list(range(1, len(committed) + 1)), "cursors are gap-free from 1"
    assert dict(seen) == {entity_id: committed[entity_id] for entity_id in committed}
