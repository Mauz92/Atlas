"""A small in-process sliding-window rate limiter.

Suitable for the single-process deployment Atlas targets. If the API is ever scaled out,
this must move to a shared store; the limitation is noted in ``docs/SECURITY.md``.
"""

from __future__ import annotations

import math
import time
from collections import defaultdict, deque

#: above this many tracked keys, buckets with no live hit are dropped (keys may be attacker-chosen,
#: for example an e-mail address on the recovery endpoint, so the table must not grow without bound)
_PRUNE_AT = 4096


class RateLimiter:
    def __init__(self, limit: int, per_seconds: float = 60.0) -> None:
        self._limit = limit
        self._per_seconds = per_seconds
        self._hits: dict[str, deque[float]] = defaultdict(deque)

    def allow(self, key: str, now: float | None = None) -> bool:
        moment = time.monotonic() if now is None else now
        if len(self._hits) >= _PRUNE_AT:
            self._prune(moment)
        bucket = self._hits[key]
        cutoff = moment - self._per_seconds
        while bucket and bucket[0] <= cutoff:
            bucket.popleft()
        if len(bucket) >= self._limit:
            return False
        bucket.append(moment)
        return True

    def _prune(self, moment: float) -> None:
        cutoff = moment - self._per_seconds
        for key in [k for k, hits in self._hits.items() if not hits or hits[-1] <= cutoff]:
            del self._hits[key]

    def retry_after(self, key: str, now: float | None = None) -> int:
        """Whole seconds (at least 1) until ``key`` may try again; for a ``Retry-After`` header."""
        moment = time.monotonic() if now is None else now
        bucket = self._hits.get(key)
        if not bucket:
            return 1
        return max(1, math.ceil(bucket[0] + self._per_seconds - moment))

    def reset(self) -> None:
        self._hits.clear()
