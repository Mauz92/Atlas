"""Discrete-event core of the sync simulation (SYNC-02).

Everything is deterministic: one seeded :class:`random.Random` drives the schedule and the faults,
time is a virtual integer (milliseconds), and nothing reads the wall clock. A run is fully described
by ``(seed, SimConfig, bugs)``; :class:`SimFailure` prints the seed so any failure reproduces with
``ATLAS_SIM_SEED=<seed>``.

The network is the only place faults are injected. A request travels
``client -> (delay) -> server.handle -> (delay) -> client``; each leg may be lost, duplicated or
slowed, so replies can arrive after the client has timed out and retried (which is how requests
overtake each other). The server is reached through the :class:`ServerPort` interface so the same
simulation runs against the in-memory model and against the real FastAPI application.
"""

from __future__ import annotations

import heapq
import os
import random
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Protocol


@dataclass(frozen=True)
class Req:
    method: str
    path: str
    params: dict[str, Any] = field(default_factory=dict)
    body: dict[str, Any] | None = None
    headers: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class Resp:
    status: int
    body: Any = None


class ServerPort(Protocol):
    async def handle(self, req: Req) -> Resp: ...

    async def head(self) -> int: ...

    async def all_entity_ids(self) -> list[str]: ...


class SimFailure(AssertionError):
    """An invariant failed. The message always carries the seed and the tail of the trace."""

    def __init__(self, seed: int, invariant: str, detail: str, trace: list[str]) -> None:
        self.seed = seed
        self.invariant = invariant
        tail = "\n    ".join(trace[-30:])
        super().__init__(
            f"[sim seed={seed}] invariant '{invariant}' violated: {detail}\n"
            f"  reproduce: ATLAS_SIM_SEED={seed} python -m pytest services/api/tests/sim -x\n"
            f"  last events:\n    {tail}"
        )


def env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    return int(raw) if raw else default


@dataclass
class SimConfig:
    """Shape of one run. Defaults keep a seed cheap; the soak knobs are environment variables."""

    clients: int = 3
    steps: int = 120
    action_p: float = 0.35  # chance a client does a user action in a step
    # transport faults, applied per request while ``faults`` is on
    p_drop_request: float = 0.07
    p_drop_response: float = 0.10
    p_duplicate: float = 0.06
    p_server_error: float = 0.04
    p_slow: float = 0.10
    # environment
    p_toggle_online: float = 0.04
    p_restart: float = 0.03
    p_clock_jump: float = 0.05
    p_purge: float = 0.0  # server feed retention purge (model server only)
    max_clock_skew: int = 86_400_000  # +/- one day
    skew: bool = True
    timeout: int = 120
    max_quiesce_ticks: int = 4000
    kinds: tuple[str, ...] = ("task", "project")
    #: model server only: check that a client holds every feed row at or below its cursor
    check_cursor_rows: bool = True
    #: protocol v1 (SYNC-03): clients use ``Atlas-Sync: 1`` (client ids, field merge, edit wins,
    #: ``include=data`` pulls, snapshot resync)
    sync: bool = False
    #: the last client joins only after 60 % of the steps, with an empty store (snapshot bootstrap)
    late_joiner: bool = False
    #: one extra client speaks an unsupported protocol (must be refused with 426 and stop)
    old_client: bool = False


class EventQueue:
    """Virtual clock plus a (time, sequence)-ordered heap of callbacks."""

    def __init__(self) -> None:
        self.now = 0
        self._heap: list[tuple[int, int, Callable[[], Awaitable[None] | None]]] = []
        self._counter = 0

    def at(self, delay: int, fn: Callable[[], Awaitable[None] | None]) -> None:
        self._counter += 1
        heapq.heappush(self._heap, (self.now + max(0, delay), self._counter, fn))

    async def run_due(self) -> int:
        ran = 0
        while self._heap and self._heap[0][0] <= self.now:
            _, _, fn = heapq.heappop(self._heap)
            result = fn()
            if result is not None:
                await result
            ran += 1
        return ran

    def pending(self) -> int:
        return len(self._heap)


class Network:
    """Carries requests to a :class:`ServerPort` and replies back, injecting faults."""

    def __init__(
        self,
        events: EventQueue,
        server: ServerPort,
        rng: random.Random,
        cfg: SimConfig,
        trace: list[str],
    ) -> None:
        self.events = events
        self.server = server
        self.rng = rng
        self.cfg = cfg
        self.trace = trace
        self.faults = True
        self.online: dict[str, bool] = {}
        self.sent = 0

    def send(self, client_id: str, req: Req, on_reply: Callable[[Resp | None], None]) -> None:
        """Send ``req``; ``on_reply`` gets the response, or ``None`` if the reply never arrives."""
        self.sent += 1
        cfg, rng = self.cfg, self.rng
        roll = rng.random() if self.faults else 1.0
        slow = 150 if (self.faults and rng.random() < cfg.p_slow) else 0
        up = rng.randint(1, 25) + slow
        down = rng.randint(1, 25) + (150 if (self.faults and rng.random() < cfg.p_slow) else 0)
        drop_req = roll < cfg.p_drop_request
        edge = cfg.p_drop_request + cfg.p_drop_response
        drop_resp = cfg.p_drop_request <= roll < edge
        duplicate = edge <= roll < edge + cfg.p_duplicate
        error = edge + cfg.p_duplicate <= roll < edge + cfg.p_duplicate + cfg.p_server_error
        label = f"{client_id} {req.method} {req.path}"
        if drop_req:
            self.trace.append(f"t={self.events.now} net DROP-REQUEST {label}")
            return

        async def arrive(deliver: bool = True) -> None:
            resp = await self.server.handle(req)
            if drop_resp or not deliver:
                if drop_resp and deliver:
                    self.trace.append(
                        f"t={self.events.now} net DROP-RESPONSE (applied) {label} -> {resp.status}"
                    )
                return
            if error:
                self.trace.append(f"t={self.events.now} net 503-AFTER-APPLY {label}")
                resp = Resp(503, {"detail": "injected"})
            self.events.at(down, lambda: self._deliver(client_id, label, resp, on_reply))

        self.events.at(up, arrive)
        if duplicate:
            self.trace.append(f"t={self.events.now} net DUPLICATE {label}")
            self.events.at(up + rng.randint(1, 60), lambda: arrive(deliver=False))

    def _deliver(
        self, client_id: str, label: str, resp: Resp, on_reply: Callable[[Resp | None], None]
    ) -> None:
        if not self.online.get(client_id, True):
            self.trace.append(f"t={self.events.now} net reply lost (offline) {label}")
            return
        on_reply(resp)
