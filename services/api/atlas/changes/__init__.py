"""Per-user change feed (M7-01): the incremental pull across structured entities.

``GET /api/changes?since=<cursor>`` returns everything the calling user changed after the cursor —
tasks, projects, notes *metadata* and the note↔project links, including soft-delete tombstones —
ordered by a monotonic per-user cursor, so a client converges without re-fetching everything.

- :mod:`atlas.changes.feed` — the pure vocabulary, cursor/limit validation and page planner.
- :mod:`atlas.changes.record` — the write side (:class:`ChangeRecorder`), called from the services.
- :mod:`atlas.changes.service` — the read side (:class:`ChangesService`).
- :mod:`atlas.changes.retention` — the pure retention window / resync-floor rules (M7-02).
- :mod:`atlas.changes.purge` — the retention purge that bounds the feed history (M7-02).
- The durable store is ``atlas.models.ChangeLog`` (one row per changed entity).

The decision records are ``DECISIONS.md`` ADR-0032 (the feed) and ADR-0033 (retention + resync).
"""

from .feed import (
    DEFAULT_CHANGE_LIMIT,
    MAX_CHANGE_LIMIT,
    MAX_CURSOR,
    ChangeEntityType,
    ChangeOperation,
    ChangeSet,
    FeedChange,
    FeedPagePlan,
    InvalidChangeCursorError,
    entity_id_for,
    merge_latest,
    note_project_link_id,
    parse_limit,
    parse_since,
    parse_types,
    plan_change_page,
    task_note_link_id,
)
from .purge import ChangePurgeService, PurgeSummary
from .record import ChangeRecorder
from .retention import (
    DEFAULT_RETENTION_DAYS,
    InvalidRetentionError,
    ResyncReason,
    resync_reason,
    resync_required,
    retention_cutoff,
)
from .service import ChangesService

__all__ = [
    "DEFAULT_CHANGE_LIMIT",
    "DEFAULT_RETENTION_DAYS",
    "MAX_CHANGE_LIMIT",
    "MAX_CURSOR",
    "ChangeEntityType",
    "ChangeOperation",
    "ChangePurgeService",
    "ChangeRecorder",
    "ChangeSet",
    "ChangesService",
    "FeedChange",
    "FeedPagePlan",
    "InvalidChangeCursorError",
    "InvalidRetentionError",
    "PurgeSummary",
    "ResyncReason",
    "entity_id_for",
    "merge_latest",
    "note_project_link_id",
    "parse_limit",
    "parse_since",
    "parse_types",
    "plan_change_page",
    "resync_reason",
    "resync_required",
    "retention_cutoff",
    "task_note_link_id",
]
