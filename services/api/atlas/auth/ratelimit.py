"""A small in-process sliding-window rate limiter.

Suitable for the single-process deployment Atlas targets. If the API is ever scaled out,
this must move to a shared store; the limitation is noted in ``docs/SECURITY.md``.
"""

from __future__ import annotations

import time
from collections import defaultdict, deque


class RateLimiter:
    def __init__(self, limit: int, per_seconds: float = 60.0) -> None:
        self._limit = limit
        self._per_seconds = per_seconds
        self._hits: dict[str, deque[float]] = defaultdict(deque)

    def allow(self, key: str, now: float | None = None) -> bool:
        moment = time.monotonic() if now is None else now
        bucket = self._hits[key]
        cutoff = moment - self._per_seconds
        while bucket and bucket[0] <= cutoff:
            bucket.popleft()
        if len(bucket) >= self._limit:
            return False
        bucket.append(moment)
        return True

    def reset(self) -> None:
        self._hits.clear()
