"""Pure rules of the automatic-resolution log (SYNC-05; ``SYNC_PROTOCOL.md`` section 9).

No database and no clock here: which rules exist, which of them can be undone and why the others
cannot, how big a stored value may be, and the opaque paging cursor of the list endpoint. The
service that stores the rows is :mod:`atlas.sync.resolution_log`.
"""

from __future__ import annotations

import base64
import json
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any

SIMPLE_LATER_WINS = "simple_later_wins"
EDIT_WINS_OVER_DELETE = "edit_wins_over_delete"
NOTE_MERGED = "note_merged"
PATH_COLLISION = "path_collision"
PATH_LATER_WINS = "path_later_wins"
UNDO = "undo"

RULES: tuple[str, ...] = (
    SIMPLE_LATER_WINS,
    EDIT_WINS_OVER_DELETE,
    NOTE_MERGED,
    PATH_COLLISION,
    PATH_LATER_WINS,
    UNDO,
)

#: Rules whose effect is "a simple field kept the later value": undo re-applies the stored loser.
UNDOABLE_RULES = frozenset({SIMPLE_LATER_WINS, PATH_LATER_WINS})

#: The most a stored overwritten value may take once serialised. Simple fields are tiny; a value
#: beyond this is not stored (the entry then cannot be undone) instead of growing the table.
MAX_LOSER_BYTES = 4096
MAX_DETAIL_CHARS = 2048

#: ``GET /api/sync/resolutions`` page size.
DEFAULT_LIST_LIMIT = 50
MAX_LIST_LIMIT = 200


class UndoTargetDeletedError(RuntimeError):
    """The entity an undo would write to is deleted; an undo never brings an entity back."""


class UndoChangedSinceError(RuntimeError):
    """A newer change to the field exists; the undo is refused rather than overwriting it."""

    def __init__(self, field: str, server_value: Any, server_revision: int | None) -> None:
        super().__init__(f"{field} changed after the resolution")
        self.field = field
        self.server_value = server_value
        self.server_revision = server_revision


@dataclass(frozen=True, slots=True)
class FollowUp:
    """What to do instead when a resolution cannot be undone (explicit, never silent)."""

    kind: str  # note_history | delete_again | rename | none
    href: str | None = None


@dataclass(frozen=True, slots=True)
class Undoability:
    undoable: bool
    #: why not: ``already_undone`` | ``rule_not_undoable`` | ``value_not_stored`` | ``is_undo``
    reason: str | None = None
    follow_up: FollowUp | None = None


def undo_status(
    *,
    rule: str,
    entity_type: str,
    entity_id: uuid.UUID | str,
    kept_revision: int | None,
    field: str | None,
    has_loser: bool,
    undone: bool,
) -> Undoability:
    """Whether a resolution can be undone, and what to do when it cannot.

    - ``simple_later_wins`` / ``path_later_wins``: undoable while the overwritten value is stored
      and the entry has not been undone.
    - ``note_merged``: not undoable; the other version is in the note history (``follow_up``).
    - ``edit_wins_over_delete``: not undoable; "delete again" is an ordinary delete.
    - ``path_collision``: not undoable; the wanted path is taken, rename the note.
    - ``undo``: not undoable (an undo is final; edit the field to change it again).
    """
    if rule == UNDO:
        return Undoability(False, "is_undo")
    if undone:
        return Undoability(False, "already_undone")
    if rule == NOTE_MERGED:
        href = (
            f"/api/notes/{entity_id}/history/{kept_revision}" if kept_revision is not None else None
        )
        return Undoability(False, "rule_not_undoable", FollowUp("note_history", href))
    if rule == EDIT_WINS_OVER_DELETE:
        return Undoability(False, "rule_not_undoable", FollowUp("delete_again"))
    if rule == PATH_COLLISION:
        return Undoability(False, "rule_not_undoable", FollowUp("rename"))
    if rule in UNDOABLE_RULES and field is not None and has_loser:
        return Undoability(True)
    return Undoability(False, "value_not_stored")


def bounded_loser(value: Any) -> tuple[Any, bool]:
    """``(value, stored)``: the value as JSON-safe data, or ``(None, False)`` if it is too large."""
    try:
        encoded = json.dumps(value, separators=(",", ":"), default=str)
    except (TypeError, ValueError):
        return None, False
    if len(encoded.encode("utf-8")) > MAX_LOSER_BYTES:
        return None, False
    return json.loads(encoded), True


def bounded_detail(detail: str | None) -> str | None:
    if detail is None:
        return None
    return detail[:MAX_DETAIL_CHARS]


# --- paging cursor of the list endpoint ---------------------------------------------------------


class InvalidResolutionCursorError(ValueError):
    """The ``cursor`` of a list request is not one this server issued."""


def encode_cursor(created_at: datetime, ordinal: int, row_id: uuid.UUID) -> str:
    """The list order is ``(created_at, ordinal, id)`` descending: entries written by one request
    share ``created_at`` (the transaction's time), so ``ordinal`` (their position in the request)
    makes the order of a request's own entries deterministic."""
    raw = f"{created_at.isoformat()}|{ordinal}|{row_id}".encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_cursor(cursor: str) -> tuple[datetime, int, uuid.UUID]:
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        stamp, ordinal, ident = base64.urlsafe_b64decode(padded.encode()).decode().split("|")
        return datetime.fromisoformat(stamp), int(ordinal), uuid.UUID(ident)
    except (ValueError, UnicodeDecodeError) as exc:
        raise InvalidResolutionCursorError("cursor is not valid") from exc


def parse_limit(value: int | None) -> int:
    if value is None:
        return DEFAULT_LIST_LIMIT
    if value < 1 or value > MAX_LIST_LIMIT:
        raise ValueError(f"limit must be between 1 and {MAX_LIST_LIMIT}")
    return value
