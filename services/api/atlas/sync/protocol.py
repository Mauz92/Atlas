"""Sync protocol versioning and the structured sync-mode error (SYNC-03b; SYNC_PROTOCOL.md 10.2).

A client opts in per request with ``Atlas-Sync: <protocol major>``. Without the header every
endpoint behaves exactly as before the protocol existed. The server accepts ``PROTOCOL_MIN`` ..
``PROTOCOL_MAX``; anything else (including a value that is not an integer) is ``426`` so an old or
new client stops instead of writing with semantics the server does not share.
"""

from __future__ import annotations

from typing import Any

#: Request header that switches an endpoint to sync mode and names the protocol major.
SYNC_HEADER = "Atlas-Sync"
#: Optional request header: the epoch the client last saw (``GET /api/instance`` ``sync.epoch``).
EPOCH_HEADER = "Atlas-Epoch"
PROTOCOL_MIN = 1
PROTOCOL_MAX = 1

#: Schema number of each entity type in the feed ``data`` payload (bumped on a breaking change).
ENTITY_SCHEMAS: dict[str, int] = {
    "task": 1,
    "project": 1,
    "note": 1,
    "note_project_link": 1,
    "task_note_link": 1,
}

#: ``include=data`` pages are smaller because every item carries its entity.
MAX_DATA_LIMIT = 200


class SyncError(Exception):
    """A sync-mode failure with a machine-readable ``error`` code (SYNC_PROTOCOL.md 6.1, 8.1)."""

    def __init__(self, status_code: int, error: str, detail: str, **extra: Any) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.error = error
        self.detail = detail
        self.extra = extra

    def body(self) -> dict[str, Any]:
        return {"error": self.error, "detail": self.detail, **self.extra}


def parse_protocol(raw: str | None) -> int | None:
    """The protocol major in ``Atlas-Sync``, or ``None`` when the header is absent.

    Raises :class:`SyncError` (426) for a value outside ``PROTOCOL_MIN..PROTOCOL_MAX``.
    """
    if raw is None:
        return None
    text = raw.strip()
    version = int(text) if text.isascii() and text.isdigit() and len(text) < 6 else None
    if version is None or not PROTOCOL_MIN <= version <= PROTOCOL_MAX:
        raise SyncError(
            426,
            "sync_version_unsupported",
            f"this server supports sync protocol {PROTOCOL_MIN} to {PROTOCOL_MAX}; update the app",
            min=PROTOCOL_MIN,
            max=PROTOCOL_MAX,
        )
    return version
