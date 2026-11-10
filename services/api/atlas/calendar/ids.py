"""Stable, collision-free identifiers for projected events (ADR-0071).

``external_events`` is unique per ``(user, provider, external_event_id)`` and the same Google event
id can appear in two calendars (a shared invitation), so an adapter namespaces every event id with
a short digest of its calendar id. The result is deterministic (the same event always maps to the
same row, so retries and resyncs never duplicate) and bounded (a Graph id plus a calendar id would
overflow the column).
"""

from __future__ import annotations

import hashlib


def namespace(calendar_id: str) -> str:
    """A 12-hex-digit digest identifying one calendar inside a provider."""
    return hashlib.sha256(calendar_id.encode("utf-8")).hexdigest()[:12]


def event_key(calendar_id: str, raw_id: str, *, max_length: int = 480) -> str:
    """The projection id for provider event ``raw_id`` in ``calendar_id``."""
    key = f"{namespace(calendar_id)}:{raw_id}"
    if len(key) <= max_length:
        return key
    tail = hashlib.sha256(raw_id.encode("utf-8")).hexdigest()
    return f"{namespace(calendar_id)}:h:{tail}"
