"""Request and response schemas."""

from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Annotated, Any, Literal

import email_validator
from email_validator import EmailNotValidError, validate_email
from pydantic import (
    AfterValidator,
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    field_validator,
    model_validator,
)

from ..calendar import (
    MAX_SCOPE_COUNT,
    MAX_TOKEN_LENGTH,
    MAX_TOKEN_TYPE_LENGTH,
    CursorHealth,
    SyncState,
)
from ..changes import ResyncReason
from ..models import ProjectStatus, PushChannel, TaskPriority, TaskStatus
from ..notifications import MAX_ENDPOINT_LENGTH, MAX_KEY_LENGTH, MAX_PLATFORM_LENGTH
from ..reminders import MAX_DAYS_BEFORE, InvalidReminderTimingError, format_at_time, parse_at_time
from ..reminders import ReminderTiming as DomainReminderTiming
from ..tasks import (
    MAX_PREVIEW,
    DueState,
    InvalidRecurrenceRuleError,
    is_valid_time_zone,
    validate_rule,
)

# ``email_validator`` rejects ``.local`` (mDNS) as special-use even in test mode. A self-hosted,
# single-owner instance on a home network legitimately uses ``me@host.local``; the library
# documents this list as adjustable. Only ``local`` is released; ``invalid``, ``localhost`` and the
# rest stay rejected.
if "local" in email_validator.SPECIAL_USE_DOMAIN_NAMES:
    email_validator.SPECIAL_USE_DOMAIN_NAMES.remove("local")


def _check_email(value: str) -> str:
    """Syntax-check and normalise an address.

    Atlas is single-owner and self-hosted, so special-use domains such as ``.test`` or ``.local``
    are accepted; deliverability is never checked (no DNS lookups).
    """
    try:
        return validate_email(value, check_deliverability=False, test_environment=True).normalized
    except EmailNotValidError as exc:
        raise ValueError(str(exc)) from exc


Email = Annotated[str, AfterValidator(_check_email)]


class LoginRequest(BaseModel):
    email: Email
    password: str = Field(min_length=1, max_length=1024)


class SetupRequest(BaseModel):
    email: Email
    password: str = Field(min_length=12, max_length=1024)
    display_name: str = Field(min_length=1, max_length=120)


class RecoveryReset(BaseModel):
    """Forgot-password reset: the account's e-mail, its recovery code and a new password."""

    email: Email
    recovery_code: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=12, max_length=1024)


class RecoveryRegenerate(BaseModel):
    current_password: str = Field(min_length=1, max_length=1024)


class RecoveryCodeIssued(BaseModel):
    """A freshly issued recovery code. This response is the only place the code ever appears."""

    recovery_code: str
    created_at: datetime


class RecoveryStatus(BaseModel):
    enabled: bool = Field(description="False when the operator set RECOVERY_ENABLED=false.")
    configured: bool = Field(description="Whether the account has a recovery code.")
    created_at: datetime | None = None
    last_used_at: datetime | None = Field(
        default=None, description="When the code last reset the password (null: never used)."
    )
    failed_attempts: int = Field(
        default=0, description="Wrong tries since the code was last used or issued."
    )


class ProfileUpdate(BaseModel):
    display_name: str = Field(min_length=1, max_length=120)

    @field_validator("display_name")
    @classmethod
    def _strip(cls, value: str) -> str:
        value = value.strip()
        if not value:
            msg = "Name must not be blank"
            raise ValueError(msg)
        return value


class PasswordChange(BaseModel):
    current_password: str = Field(min_length=1, max_length=1024)
    new_password: str = Field(min_length=12, max_length=1024)
    revoke_devices: bool = Field(
        default=False,
        description=(
            "Also sign out every sync device (ADR-0065). Off by default: a routine password "
            "change signs out browsers only, so the desktop app keeps syncing; tick it when the "
            "old password may have been exposed."
        ),
    )


DevicePlatform = Literal["windows", "linux", "macos", "android", "ios", "web", "other"]


def _clean_device_name(value: str) -> str:
    value = " ".join(value.split())  # trims and collapses whitespace, newlines and tabs included
    if not value or any(ord(c) < 32 or ord(c) == 127 for c in value):
        msg = "Name must not be blank"
        raise ValueError(msg)
    return value


DeviceName = Annotated[str, Field(min_length=1, max_length=80), AfterValidator(_clean_device_name)]


class DeviceSignIn(BaseModel):
    """Sign a sync device in with the account's e-mail and password (SYNC-06)."""

    email: Email
    password: str = Field(min_length=1, max_length=1024)
    name: DeviceName
    platform: DevicePlatform = "other"


class DeviceRename(BaseModel):
    name: DeviceName


class DeviceInfo(BaseModel):
    id: uuid.UUID
    name: str
    platform: DevicePlatform
    created_at: datetime
    last_seen_at: datetime | None = Field(
        description="Server time of the last authenticated request (updated every few minutes)."
    )
    revoked_at: datetime | None
    current: bool = Field(description="True when this request was authenticated by this device.")


class DeviceInfoList(BaseModel):
    items: list[DeviceInfo]


class DeviceSignedIn(BaseModel):
    """A device and its bearer token. The token is shown **once**: only its hash is stored, so a
    lost token means signing the device in again."""

    device: DeviceInfo
    token: str = Field(description="`Authorization: Bearer <token>`. Keep it in the OS keystore.")


class DeviceRevokeAllOut(BaseModel):
    revoked: int


class UserPublic(BaseModel):
    id: uuid.UUID
    email: str
    display_name: str


class SetupStatus(BaseModel):
    setup_required: bool
    recovery_enabled: bool = Field(
        default=True,
        description=(
            "Whether the server issues recovery codes and accepts a forgot-password reset "
            "(RECOVERY_ENABLED, ADR-0067). The sign-in page uses it to word its help."
        ),
    )


class SetupResult(UserPublic):
    """The new owner, plus the one-time recovery code (``null`` when recovery is disabled)."""

    recovery_code: str | None = Field(
        default=None,
        description="Shown once, never again; the server keeps only a salted hash (ADR-0067).",
    )


class HealthStatus(BaseModel):
    status: str
    version: str


class ReadyStatus(BaseModel):
    status: str
    database: str


class BackupLatest(BaseModel):
    backup_id: str | None
    created_at: datetime | None
    atlas_version: str | None
    database_bytes: int | None
    notes_bytes: int | None


class BackupStatus(BaseModel):
    """Read-only view of the backup destination and the scheduled job (no paths, no secrets)."""

    destination_available: bool
    sets: int
    latest: BackupLatest | None
    incomplete_sets: int
    interval_seconds: int
    retain: int
    last_job_status: str | None
    last_job_at: datetime | None


class SyncProtocolRange(BaseModel):
    min: int
    max: int


class SyncLimits(BaseModel):
    max_note_bytes: int
    feed_page_max: int
    feed_page_max_with_data: int


class InstanceSync(BaseModel):
    """What a sync client needs to know before it syncs (SYNC_PROTOCOL.md section 10.2).

    ``protocol`` is the range of ``Atlas-Sync`` majors this server accepts (anything else is
    ``426``). ``entities`` gives the schema number of each feed entity type, so a client can tell
    which types it understands. ``epoch`` names this database's history: send it back as
    ``Atlas-Epoch``; a different value means the server was restored from a backup or is another
    server, and the client must ask its user before it syncs again.
    """

    protocol: SyncProtocolRange
    entities: dict[str, int]
    limits: SyncLimits
    tombstone_retention_days: int
    idempotency_retention_days: int
    epoch: str


class InstanceInfo(BaseModel):
    version: str
    environment: str
    database: str
    migration_revision: str | None
    web_push_configured: bool
    backups: BackupStatus
    sync: InstanceSync


# --- Sync (SYNC-03) ------------------------------------------------------


class SyncConflictOut(BaseModel):
    """A field of a sync-mode ``PATCH`` that was not applied (SYNC_PROTOCOL.md section 6.2)."""

    field: str
    reason: str = Field(description="`text_conflict` or `invalid_transition`.")
    server_revision: int = Field(description="Revision at which the server's value was set.")
    server_value: Any = Field(default=None, description="The server's current value.")


class SyncResolutionOut(BaseModel):
    """An automatic resolution applied by the server, as reported in the `sync` block of a write
    response. Since SYNC-05 each one is also a row of the resolution log (`id`), announced on the
    feed as the `resolution` entity and listed by `GET /api/sync/resolutions`."""

    id: uuid.UUID | None = Field(
        default=None,
        description="The log entry (`null` only in an error body, where nothing was written).",
    )
    rule: str = Field(
        description=(
            "`simple_later_wins`, `edit_wins_over_delete`, `note_merged`, `path_collision`, "
            "`path_later_wins`."
        )
    )
    field: str | None = None
    kept_revision: int | None = None
    loser: Any = Field(default=None, description="The overwritten value of a simple field.")
    detail: str | None = None


class ResolutionFollowUp(BaseModel):
    """What to do when a resolution cannot be undone."""

    kind: str = Field(
        description=(
            "`note_history` (the other version is in the note's history, `href` points at it), "
            "`delete_again` (an ordinary delete) or `rename` (choose another path)."
        )
    )
    href: str | None = None


class ResolutionOut(BaseModel):
    """One entry of the automatic-resolution log (SYNC-05; `SYNC_PROTOCOL.md` section 9).

    Never holds text: `loser` is the overwritten value of a *simple* field only (a status, a
    priority, a date, a path). For text and note content the entry points at history instead.
    """

    id: uuid.UUID
    entity_type: str = Field(description="`task`, `project` or `note`.")
    entity_id: uuid.UUID
    rule: str = Field(
        description=(
            "`simple_later_wins`, `edit_wins_over_delete`, `note_merged`, `path_collision`, "
            "`path_later_wins` or `undo`."
        )
    )
    field: str | None = None
    kept_revision: int | None = Field(
        default=None, description="The entity revision the winning write produced."
    )
    has_loser: bool = Field(
        description="Whether the overwritten value is stored (`loser` may itself be `null`)."
    )
    loser: Any = Field(
        default=None,
        description="The overwritten simple-field value (for `undo`: the value the undo replaced).",
    )
    detail: str | None = Field(default=None, description="Paths only, bounded; never text.")
    device_id: uuid.UUID | None = Field(
        default=None, description="Always `null` until device credentials exist (SYNC-06)."
    )
    undoes_id: uuid.UUID | None = Field(
        default=None, description="For an `undo` entry: the resolution it undid."
    )
    undone_at: datetime | None = None
    undone_by: uuid.UUID | None = None
    created_at: datetime
    undoable: bool
    undo_blocked: str | None = Field(
        default=None,
        description=(
            "Why it cannot be undone: `already_undone`, `rule_not_undoable`, `value_not_stored` "
            "or `is_undo`."
        ),
    )
    follow_up: ResolutionFollowUp | None = None


class ResolutionListOut(BaseModel):
    resolutions: list[ResolutionOut]
    next_cursor: str | None = Field(
        default=None, description="Pass as `cursor` for the next (older) page; `null` at the end."
    )


class ResolutionUndoOut(BaseModel):
    """The answer to an undo. `applied` is `false` when the field already held the restored value:
    the resolution is then still marked undone and an `undo` entry is logged."""

    applied: bool
    revision: int | None = Field(
        default=None, description="The entity's revision after the undo (unchanged if not applied)."
    )
    resolution: ResolutionOut
    undo: ResolutionOut


class SyncResult(BaseModel):
    """The `sync` block of a write response in sync mode (`Atlas-Sync: 1`); `null` otherwise."""

    revision: int
    resolution: list[SyncResolutionOut] = Field(default_factory=list)
    conflicts: list[SyncConflictOut] = Field(default_factory=list)


# --- Notes ---------------------------------------------------------------


def _valid_note_text(value: str) -> str:
    """Note text is UTF-8: a lone surrogate cannot be encoded and NUL cannot be indexed."""
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise ValueError("note text must be valid UTF-8 (no lone surrogates)") from exc
    if "\x00" in value:
        raise ValueError("note text must not contain NUL characters")
    return value


class NoteCreateRequest(BaseModel):
    id: uuid.UUID | None = Field(
        default=None, description="Optional client-generated id (UUID); see task creation."
    )
    path: str = Field(min_length=1, max_length=1024)
    content: str = Field(default="", max_length=5 * 1024 * 1024)

    _content_is_text = field_validator("content")(_valid_note_text)


class DailyNoteRequest(BaseModel):
    """The calendar day (``YYYY-MM-DD``) in the caller's time zone; the server never guesses it."""

    date: str = Field(min_length=1, max_length=32)


class NoteFromTemplateRequest(BaseModel):
    path: str = Field(min_length=1, max_length=1024)
    template_id: uuid.UUID
    date: str | None = Field(default=None, max_length=32)


class NoteUpdateRequest(BaseModel):
    content: str = Field(max_length=5 * 1024 * 1024)
    base_revision: int = Field(ge=0)
    base_hash: str | None = Field(
        default=None,
        pattern=r"^[0-9a-f]{64}$",
        description=(
            "Sync mode (required): the `content_hash` of the text the edit was made from. The "
            "server merges against that text when `base_revision` is no longer current; ignored "
            "outside sync mode."
        ),
    )

    _content_is_text = field_validator("content")(_valid_note_text)


class NoteConflictCopyRequest(BaseModel):
    content: str = Field(max_length=5 * 1024 * 1024)

    _content_is_text = field_validator("content")(_valid_note_text)


class NoteMoveRequest(BaseModel):
    path: str = Field(min_length=1, max_length=1024)
    base_revision: int | None = Field(
        default=None, ge=0, description="Sync mode (required). Not yet checked; see SYNC-04."
    )


class FolderCreateRequest(BaseModel):
    path: str = Field(min_length=1, max_length=1024)


class FolderRenameRequest(BaseModel):
    path: str = Field(min_length=1, max_length=1024)
    new_path: str = Field(min_length=1, max_length=1024)


class NoteSummaryOut(BaseModel):
    id: uuid.UUID
    path: str
    title: str
    revision: int
    content_hash: str
    size_bytes: int


class NoteLinkOut(BaseModel):
    target_path: str
    target_note_id: uuid.UUID | None


class NoteTaskOut(BaseModel):
    """A task linked to a note (MU-06): enough to list and open it, nothing more."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    title: str
    status: TaskStatus
    priority: TaskPriority
    due_at: datetime | None
    project_id: uuid.UUID | None


class NoteProjectOut(BaseModel):
    """A project linked to a note (``note_projects``)."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    status: ProjectStatus


class NoteCopyOut(BaseModel):
    """The conflict copy the server saved for a write it could not merge (sync mode)."""

    id: uuid.UUID
    path: str
    revision: int
    content_hash: str


class NoteSyncResult(SyncResult):
    """The `sync` block of a sync-mode note write.

    ``merged`` is true when the `content` returned differs from the text the client sent (the
    server combined it with other edits, or the client's edits were already there): the client must
    replace its file with the returned content and take `revision` / `content_hash` as its new base.
    """

    merged: bool = False


class NoteHistoryEntryOut(BaseModel):
    revision: int
    content_hash: str
    size_bytes: int
    path: str
    reason: str
    created_at: datetime
    available: bool = Field(description="False once the text of this revision has been pruned.")


class NoteHistoryOut(BaseModel):
    revisions: list[NoteHistoryEntryOut]


class NoteRevisionOut(NoteHistoryEntryOut):
    content: str


class NoteDetailOut(NoteSummaryOut):
    content: str
    tags: list[str]
    links: list[NoteLinkOut]
    backlinks: list[NoteSummaryOut]
    unresolved_links: list[str]
    #: Tasks and projects that link to this note: the non-note part of its backlinks (MU-06).
    tasks: list[NoteTaskOut]
    projects: list[NoteProjectOut]
    sync: NoteSyncResult | None = None


class TaskNotesOut(BaseModel):
    """The notes linked to one task (MU-06)."""

    notes: list[NoteSummaryOut]


class NoteListOut(BaseModel):
    notes: list[NoteSummaryOut]
    folders: list[str]


class ReconcileOut(BaseModel):
    added: int
    updated: int
    removed: int
    unchanged: int


# --- Tasks ---------------------------------------------------------------


def _validate_time_zone(value: str | None) -> str | None:
    if value is not None and not is_valid_time_zone(value):
        raise ValueError("unknown IANA time zone")
    return value


def _validate_recurrence_rule(value: str | None) -> str | None:
    if value is None:
        return value
    try:
        validate_rule(value)
    except InvalidRecurrenceRuleError as exc:
        raise ValueError(str(exc)) from exc
    return value


class TaskCreateRequest(BaseModel):
    id: uuid.UUID | None = Field(
        default=None,
        description=(
            "Optional client-generated id (UUID). Idempotent: the same id with the same body "
            "replays the create; a taken id is `409 id_exists`. Without it the server assigns one."
        ),
    )
    title: str = Field(min_length=1, max_length=512)
    description: str | None = Field(default=None, max_length=20000)
    status: TaskStatus = TaskStatus.INBOX
    priority: TaskPriority = TaskPriority.NONE
    project_id: uuid.UUID | None = None
    parent_task_id: uuid.UUID | None = None
    start_at: datetime | None = None
    due_at: datetime | None = None
    time_zone: str | None = Field(default=None, max_length=64)
    duration_minutes: int | None = Field(default=None, ge=0)
    recurrence_rule: str | None = Field(default=None, max_length=2000)
    external_provider: str | None = Field(default=None, max_length=32)
    external_id: str | None = Field(default=None, max_length=255)
    tags: list[Annotated[str, Field(max_length=64)]] | None = Field(default=None, max_length=20)

    @field_validator("time_zone")
    @classmethod
    def _check_time_zone(cls, value: str | None) -> str | None:
        return _validate_time_zone(value)

    @field_validator("recurrence_rule")
    @classmethod
    def _check_recurrence_rule(cls, value: str | None) -> str | None:
        return _validate_recurrence_rule(value)


class TaskUpdateRequest(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=512)
    description: str | None = Field(default=None, max_length=20000)
    status: TaskStatus | None = None
    priority: TaskPriority | None = None
    project_id: uuid.UUID | None = None
    parent_task_id: uuid.UUID | None = None
    start_at: datetime | None = None
    due_at: datetime | None = None
    time_zone: str | None = Field(default=None, max_length=64)
    duration_minutes: int | None = Field(default=None, ge=0)
    completed_at: datetime | None = None
    recurrence_rule: str | None = Field(default=None, max_length=2000)
    recurrence_parent_id: uuid.UUID | None = None
    external_provider: str | None = Field(default=None, max_length=32)
    external_id: str | None = Field(default=None, max_length=255)
    base_revision: int | None = Field(default=None, ge=0)
    tags: list[Annotated[str, Field(max_length=64)]] | None = Field(default=None, max_length=20)

    @field_validator("time_zone")
    @classmethod
    def _check_time_zone(cls, value: str | None) -> str | None:
        return _validate_time_zone(value)

    @field_validator("recurrence_rule")
    @classmethod
    def _check_recurrence_rule(cls, value: str | None) -> str | None:
        return _validate_recurrence_rule(value)


class TaskOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    title: str
    description: str | None
    status: str
    priority: str
    project_id: uuid.UUID | None
    parent_task_id: uuid.UUID | None
    subtasks_total: int = 0
    subtasks_done: int = 0
    start_at: datetime | None
    due_at: datetime | None
    due_state: DueState = DueState.NONE
    time_zone: str | None
    duration_minutes: int | None
    completed_at: datetime | None
    recurrence_rule: str | None
    recurrence_parent_id: uuid.UUID | None
    external_provider: str | None
    external_id: str | None
    tags: list[str] = Field(default_factory=list)
    revision: int
    field_revisions: dict[str, int] = Field(
        default_factory=dict,
        description=(
            "Field name -> the revision at which that field last changed (SYNC-03). Used by "
            "sync-mode clients to merge; informational otherwise."
        ),
    )
    created_at: datetime
    updated_at: datetime
    sync: SyncResult | None = None


class RecurrencePreviewRequest(BaseModel):
    """Ask what an RRULE means for a task anchored at ``anchor`` (read-only, nothing is stored)."""

    rule: str = Field(min_length=1, max_length=2000)
    anchor: datetime = Field(
        description="First occurrence; naive wall-clock time is read in `time_zone`."
    )
    time_zone: str | None = Field(default=None, max_length=64)
    limit: int = Field(default=5, ge=1, le=MAX_PREVIEW)


class RecurrencePreviewOut(BaseModel):
    """The series' next occurrences as UTC instants, ascending (fewer when the series ends)."""

    occurrences: list[datetime]


class TaskListOut(BaseModel):
    tasks: list[TaskOut]


class TaskChangeOut(TaskOut):
    """A task in the incremental change feed (M3-09).

    Same shape as :class:`TaskOut` plus ``deleted_at``: a non-null value marks a *tombstone* — the
    task was soft-deleted and the client should remove its local copy.
    """

    deleted_at: datetime | None = None


class TaskChangesOut(BaseModel):
    """One page of the task change feed.

    ``tasks`` are the changed tasks (live and tombstoned) ordered by ``revision`` ascending.
    ``since`` echoes the requested cursor; ``next_since`` is the new high-water mark to send on the
    next pull; ``has_more`` says whether further changes remain after ``next_since``.
    """

    tasks: list[TaskChangeOut]
    since: int
    next_since: int
    has_more: bool


# --- Change feed (M7-01) -------------------------------------------------


class TaskSyncData(BaseModel):
    """A task as stored, in the feed with `include=data` (SYNC-03e): persisted columns, `tags` and
    `field_revisions`; no derived values (`due_state`, subtask counts). A tombstone has
    `deleted_at`."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    revision: int
    field_revisions: dict[str, int]
    deleted_at: datetime | None
    created_at: datetime
    updated_at: datetime
    title: str
    description: str | None
    status: str
    priority: str
    project_id: uuid.UUID | None
    parent_task_id: uuid.UUID | None
    start_at: datetime | None
    due_at: datetime | None
    time_zone: str | None
    duration_minutes: int | None
    completed_at: datetime | None
    recurrence_rule: str | None
    recurrence_parent_id: uuid.UUID | None
    external_provider: str | None
    external_id: str | None
    reminder_policy_id: uuid.UUID | None
    tags: list[str]


class ProjectSyncData(BaseModel):
    """A project as stored (no derived `progress`), in the feed with `include=data`."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    revision: int
    field_revisions: dict[str, int]
    deleted_at: datetime | None
    created_at: datetime
    updated_at: datetime
    name: str
    description: str | None
    status: str
    start_date: date | None
    target_date: date | None


class NoteSyncData(BaseModel):
    """A note's metadata (never its content) in the feed with `include=data`."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    revision: int
    deleted_at: datetime | None
    created_at: datetime
    updated_at: datetime
    path: str
    title: str
    content_hash: str
    size_bytes: int


class ChangeOut(BaseModel):
    """One item of the per-user change feed (M7-01).

    ``entity_type`` is one of ``task`` | ``project`` | ``note`` | ``note_project_link`` |
    ``task_note_link``; ``operation`` is ``upsert`` (created/updated) or ``delete`` (soft-deleted
    tombstone). ``entity_id`` identifies the entity within its type — the entity's UUID for a
    task/project/note, or ``"{note_id}:{project_id}"`` for a note↔project link. ``cursor`` is the
    change's position on the caller's monotonic cursor, which a client sends back as ``since`` to
    continue. The feed carries **no** entity payload: a client fetches the entity it cares about
    from the ordinary endpoint, or removes it locally when the operation is ``delete``.
    """

    entity_type: str
    entity_id: str
    operation: str
    cursor: int
    changed_at: datetime
    revision: int | None = Field(
        default=None, description="With `include=data`: the entity's current revision."
    )
    data: TaskSyncData | ProjectSyncData | NoteSyncData | ResolutionOut | ReminderOut | None = (
        Field(
            default=None,
            description=(
                "With `include=data`: the entity's stored state as of this response, which may be "
                "newer than `cursor`; apply by `revision`. Links carry no data; `null` also "
                "when the entity no longer exists."
            ),
        )
    )


class ChangesOut(BaseModel):
    """One page of the per-user change feed.

    ``changes`` are the caller's changes after the requested cursor, ordered by ``cursor``
    ascending (each entity appears once, at its latest change). ``since`` echoes the requested
    cursor; ``next_since`` is the new high-water mark to send on the next pull; ``has_more`` says
    whether further changes remain after ``next_since``.

    ``resync_required`` (M7-02) is normally ``False``. It is ``True`` when the requested ``since``
    predates the retention floor: the changes in between have been purged and can never be
    delivered, so the client must **full-resync** (fetch the entities afresh) rather than trust the
    — empty — ``changes`` list, then resume from ``next_since``. Adding it defaults to ``False`` so
    existing clients are unaffected.

    ``resync_reason`` (SYNC-01) is ``null`` unless ``resync_required``; then ``below_floor`` (the
    cursor predates the purge floor) or ``cursor_ahead`` (the cursor is beyond the server's head,
    e.g. the server was restored from an older backup: the server has lost changes the client holds,
    so the client must not assume it is up to date and must not silently discard local state).

    SYNC-03e: `since=0` is a **snapshot** (every live entity, no tombstones on its first page);
    `types=` limits the entity types (the cursor still advances over the others); `include=data`
    adds `revision` and `data` to each item; `head` and `floor` report the feed's bounds.
    """

    changes: list[ChangeOut]
    since: int
    next_since: int
    has_more: bool
    resync_required: bool = False
    resync_reason: ResyncReason | None = None
    head: int = Field(default=0, description="The user's last allocated cursor (SYNC-03e).")
    floor: int = Field(
        default=0, description="The highest purged tombstone cursor; 0 when none was purged."
    )


# --- Projects ------------------------------------------------------------


class ProjectCreateRequest(BaseModel):
    id: uuid.UUID | None = Field(
        default=None, description="Optional client-generated id (UUID); see task creation."
    )
    name: str = Field(min_length=1, max_length=512)
    description: str | None = Field(default=None, max_length=20000)
    status: ProjectStatus = ProjectStatus.ACTIVE
    start_date: date | None = None
    target_date: date | None = None


class ProjectUpdateRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=512)
    description: str | None = Field(default=None, max_length=20000)
    status: ProjectStatus | None = None
    start_date: date | None = None
    target_date: date | None = None
    base_revision: int | None = Field(default=None, ge=0)


class ProjectProgressOut(BaseModel):
    """Derived progress of a project (``completed`` of ``total``).

    Progress is derived, not stored (``DATA_MODEL.md`` §2.3). ``total`` counts the project's live,
    non-``archived`` tasks; ``completed`` those whose status is ``completed``; ``percent`` is
    ``round(completed * 100 / total)`` to the nearest whole percent, halves rounded up, and ``0``
    when ``total`` is 0 (a project with no countable tasks is not complete). The exact rule,
    including the exclusions, is recorded in ``DECISIONS.md`` ADR-0023 and ``PRODUCT_SPEC.md`` §5.3.
    """

    total: int
    completed: int
    percent: int


class ProjectOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    description: str | None
    status: str
    start_date: date | None
    target_date: date | None
    progress: ProjectProgressOut
    revision: int
    field_revisions: dict[str, int] = Field(
        default_factory=dict,
        description="Field name -> the revision at which that field last changed (SYNC-03).",
    )
    created_at: datetime
    updated_at: datetime
    sync: SyncResult | None = None


class ProjectListOut(BaseModel):
    projects: list[ProjectOut]


class ProjectNotesOut(BaseModel):
    """A project's linked notes (M4-05), in path order.

    Notes are listed with the standard :class:`NoteSummaryOut` shape, so a client needs no
    project-specific note model. Only live notes are returned; a note deleted from the notes side
    disappears from the list.
    """

    notes: list[NoteSummaryOut]


# --- Project export (M4-07) ----------------------------------------------


class ProjectExportTaskOut(BaseModel):
    """A task inside a project export document (M4-07).

    The documented task fields (``DATA_MODEL.md`` §2.3) with their stored values — no transient,
    request-relative derivation such as ``due_state``, so the same row always exports identically.
    Instants are ISO-8601 UTC; only live (non-deleted) tasks are exported.
    """

    id: uuid.UUID
    title: str
    description: str | None
    status: str
    priority: str
    project_id: uuid.UUID | None
    parent_task_id: uuid.UUID | None
    start_at: datetime | None
    due_at: datetime | None
    time_zone: str | None
    duration_minutes: int | None
    completed_at: datetime | None
    recurrence_rule: str | None
    recurrence_parent_id: uuid.UUID | None
    external_provider: str | None
    external_id: str | None
    revision: int
    created_at: datetime
    updated_at: datetime


class ProjectExportOut(BaseModel):
    """One project and its tasks/notes in a project export document (M4-07).

    ``progress`` is the derived figure (``completed`` of ``total``, ADR-0023). ``tasks`` are every
    live task of the project (including ``archived`` ones — they are real data), while ``progress``
    excludes ``archived`` tasks by definition.
    """

    id: uuid.UUID
    name: str
    description: str | None
    status: str
    start_date: date | None
    target_date: date | None
    revision: int
    created_at: datetime
    updated_at: datetime
    progress: ProjectProgressOut
    tasks: list[ProjectExportTaskOut]
    notes: list[NoteSummaryOut]


class ProjectsExportOut(BaseModel):
    """The versioned, open project-export document (M4-07, REQ-015).

    ``format`` identifies the document (``atlas.project-export``) and ``version`` its schema
    version; both are stable contract, documented in ``DECISIONS.md`` ADR-0026. ``truncated`` is
    ``true`` when the project bound omitted further projects. Timestamps are ISO-8601 UTC.
    """

    format: str
    version: int
    generated_at: datetime
    truncated: bool
    projects: list[ProjectExportOut]


# --- Provider credentials (M5-01) ----------------------------------------


class ProviderCredentialUpsertRequest(BaseModel):
    """Write (create or replace) the caller's OAuth credential for one provider.

    The token material is accepted only over an authenticated, CSRF-protected request and is
    encrypted before it touches the database. At least one token must be supplied. ``scopes`` and
    the expiry instants are the non-secret metadata that a later sync needs.
    """

    access_token: str | None = Field(default=None, max_length=MAX_TOKEN_LENGTH)
    refresh_token: str | None = Field(default=None, max_length=MAX_TOKEN_LENGTH)
    token_type: str = Field(default="Bearer", max_length=MAX_TOKEN_TYPE_LENGTH)
    scopes: list[str] = Field(default_factory=list, max_length=MAX_SCOPE_COUNT)
    access_expires_at: datetime | None = None
    refresh_expires_at: datetime | None = None

    @model_validator(mode="after")
    def _require_a_token(self) -> ProviderCredentialUpsertRequest:
        if not (self.access_token or "").strip() and not (self.refresh_token or "").strip():
            msg = "at least one of access_token or refresh_token is required"
            raise ValueError(msg)
        return self


class ProviderCredentialRefreshRequest(BaseModel):
    """Record the result of a token refresh for an existing credential (M5-01).

    The OAuth refresh exchange itself belongs to the provider adapter; this body carries its result
    so the store can update the (re-encrypted) tokens and expiry. ``access_token`` is required.
    """

    access_token: str = Field(min_length=1, max_length=MAX_TOKEN_LENGTH)
    refresh_token: str | None = Field(default=None, max_length=MAX_TOKEN_LENGTH)
    scopes: list[str] | None = Field(default=None, max_length=MAX_SCOPE_COUNT)
    access_expires_at: datetime | None = None
    refresh_expires_at: datetime | None = None


class ProviderCredentialOut(BaseModel):
    """Non-secret metadata about a stored credential.

    Deliberately contains **no** token material and **no** ciphertext: the encryption key never
    leaves the server, and tokens are never returned by an API.
    """

    provider: str
    key_id: str
    scopes: list[str]
    access_expires_at: datetime | None
    refresh_expires_at: datetime | None
    has_refresh_token: bool
    created_at: datetime
    updated_at: datetime


class ProviderCredentialListOut(BaseModel):
    credentials: list[ProviderCredentialOut]


# --- Calendar sync status (M5-08) ----------------------------------------


class CalendarCursorStatusOut(BaseModel):
    """The derived sync status of one ``(provider, calendar)``.

    Everything here is derived from the M5-06 ``sync_cursors`` row: ``state`` (``never_synced`` |
    ``idle`` | ``error``), ``cursor_health`` (``ok`` | ``missing`` | ``error``) and the last
    success/error. ``has_cursor``/``cursor_type`` describe the cursor without ever exposing its
    opaque value. ``last_error`` is the bounded, content-free diagnostic M5-06 recorded — it never
    contains token material or event contents (ADR-0029/ADR-0030).
    """

    calendar_id: str
    state: SyncState
    cursor_health: CursorHealth
    cursor_type: str
    has_cursor: bool
    last_success_at: datetime | None
    last_error: str | None
    last_error_at: datetime | None


class ProviderSyncStatusOut(BaseModel):
    """One provider's rolled-up sync status plus its per-calendar detail.

    ``connected`` reflects whether the caller has a stored credential for the provider; ``state``/
    ``last_success_at``/``last_error`` roll the calendars up (any failing calendar makes the
    provider ``error``). No token or cursor value is ever included.
    """

    provider: str
    connected: bool
    state: SyncState
    last_success_at: datetime | None
    last_error: str | None
    last_error_at: datetime | None
    calendars: list[CalendarCursorStatusOut]
    #: The provider rejected the stored sign-in: the account must be re-authorised.
    needs_reauth: bool = False


class CalendarSyncStatusOut(BaseModel):
    """The caller's calendar sync status, one entry per connected/provider-with-a-cursor provider.

    An empty ``providers`` list means no calendar account is connected and no sync has ever run.
    """

    providers: list[ProviderSyncStatusOut]


class CalendarSyncResultOut(BaseModel):
    """The outcome of one calendar's manual sync pass (M5-08).

    Counts only — no cursor value or event content is returned. ``cursor_advanced`` says whether the
    stored cursor moved (it does not when the provider issued no new cursor or nothing changed).
    """

    calendar_id: str
    pages: int
    events_seen: int
    deletions_seen: int
    created: int
    updated: int
    unchanged: int
    tombstoned: int
    cursor_advanced: bool


class ProviderSyncOut(BaseModel):
    """The outcome of a manual provider sync: one result per calendar the account exposes."""

    provider: str
    calendars: list[CalendarSyncResultOut]


# --- Notification destinations (M8-03) -----------------------------------


class DeviceRegisterRequest(BaseModel):
    """Register (or refresh) one push destination.

    ``channel`` selects the transport: ``web`` is a Web Push subscription and **requires**
    ``p256dh`` and ``auth`` (its client keys); ``android``/``ios`` carry the push token in
    ``endpoint`` and must **not** send the Web Push keys. ``platform`` is an optional display hint.
    Registering the same ``(channel, endpoint)`` twice is idempotent — it updates the existing row.
    """

    channel: PushChannel
    endpoint: str = Field(min_length=1, max_length=MAX_ENDPOINT_LENGTH)
    p256dh: str | None = Field(default=None, max_length=MAX_KEY_LENGTH)
    auth: str | None = Field(default=None, max_length=MAX_KEY_LENGTH)
    platform: str | None = Field(default=None, max_length=MAX_PLATFORM_LENGTH)


class DeviceOut(BaseModel):
    """One registered push destination.

    The endpoint and the Web Push keys are **write-only**: they are never echoed back — only
    non-secret metadata is returned (``AGENTS.md`` §11). ``disabled_at`` is non-null when the
    delivery path reported the destination invalid/expired, so it is no longer targeted.
    """

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    channel: str
    platform: str | None
    last_seen_at: datetime
    disabled_at: datetime | None
    created_at: datetime


class DeviceListOut(BaseModel):
    """The caller's registered push destinations, oldest first."""

    devices: list[DeviceOut]


class WebPushConfigOut(BaseModel):
    """Whether Web Push is available, and the VAPID public key a browser subscribes with.

    ``enabled`` is false when the server has no VAPID key pair configured; the client then shows the
    feature as unavailable rather than offering a subscription the server could never deliver. The
    **public** key is safe to expose (it is the client-side key); the private key is never returned
    (``AGENTS.md`` §11).
    """

    enabled: bool
    vapid_public_key: str | None


# --- Reminder timing preferences (M8-05) ---------------------------------


class ReminderTiming(BaseModel):
    """When a reminder is sent, as an M8-01 policy: ``days_before`` whole days before the entity's
    due calendar day, at ``at_time`` local wall-clock time (``PRODUCT_SPEC.md`` §5.6, ADR-0037).

    ``days_before`` is bounded at the boundary (0…``MAX_DAYS_BEFORE``) and ``at_time`` must be a
    24-hour ``HH:MM`` string, so an invalid timing is rejected with no side effects.
    """

    days_before: int = Field(
        ge=0,
        le=MAX_DAYS_BEFORE,
        description="Whole days before the due date (0 = the due day).",
    )
    at_time: str = Field(
        pattern=r"^([01]\d|2[0-3]):[0-5]\d$",
        description="Local wall-clock time of day, 24-hour HH:MM.",
    )

    @field_validator("at_time")
    @classmethod
    def _check_at_time(cls, value: str) -> str:
        try:
            parse_at_time(value)
        except InvalidReminderTimingError as exc:
            raise ValueError(str(exc)) from exc
        return value

    @classmethod
    def from_domain(cls, timing: DomainReminderTiming) -> ReminderTiming:
        """Render the domain timing (the M8-01 policy shape) as the API value."""
        return cls(days_before=timing.days_before, at_time=format_at_time(timing.at_time))

    def to_domain(self) -> DomainReminderTiming:
        """Turn the validated API value into the domain timing the scheduler understands."""
        return DomainReminderTiming(
            days_before=self.days_before, at_time=parse_at_time(self.at_time)
        )


class ReminderPreferencesRequest(BaseModel):
    """Set the caller's default reminder timing, or clear it.

    A ``default`` timing sets (or updates) the single per-user default applied to the caller's tasks
    that carry no override; ``null`` clears it, so those tasks stop reminding. Idempotent. Every
    change reschedules the affected durable reminders through the M8-01 machinery.
    """

    default: ReminderTiming | None = None


class ReminderPreferencesOut(BaseModel):
    """The caller's reminder preferences: the default timing, or ``null`` when none is set."""

    default: ReminderTiming | None


class TaskReminderRequest(BaseModel):
    """Set (or clear) one task's reminder override.

    A ``timing`` sets a per-entity override that takes precedence over the caller's default;
    ``null`` clears the override, so the task falls back to the default. Idempotent, and the change
    reschedules that task's durable reminder (M8-05).
    """

    timing: ReminderTiming | None = None


class TaskReminderOut(BaseModel):
    """One task's reminder timing (M8-05).

    ``override`` is the task's own timing (``null`` when it inherits the default); ``effective`` is
    the timing actually governing the task (``null`` when it has no reminder); ``remind_at`` is the
    UTC instant the durable reminder is currently scheduled to fire, or ``null`` when there is none.
    """

    override: ReminderTiming | None
    effective: ReminderTiming | None
    remind_at: datetime | None


# --- Reminder feed entity and actions (M8-04a; SYNC_PROTOCOL.md 14.2, 14.5) -----------------------


class ReminderOut(BaseModel):
    """A reminder as a device sees it: server-computed, read-only, never any task text.

    ``remind_at`` is the UTC instant computed by the server in the task's zone (or the owner's home
    zone); ``effective_at`` is ``snoozed_until`` when set, else ``remind_at``. ``state`` is
    ``armed`` or ``cancelled`` and is **never** "sent": ``server_delivered_at`` only says that the
    server's own channel (Web Push or the logging notifier) handled it, and must not suppress a
    notification on a device. A device fires an armed reminder unless ``acknowledged_at`` is at or
    after ``effective_at``.
    """

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    revision: int = Field(description="+1 whenever state, remind_at, snooze or dismissal changes.")
    task_id: uuid.UUID
    state: Literal["armed", "cancelled"]
    remind_at: datetime
    snoozed_until: datetime | None
    acknowledged_at: datetime | None
    effective_at: datetime
    server_delivered_at: datetime | None = Field(
        default=None, description="Informational only; never gates a device notification."
    )


class ReminderListOut(BaseModel):
    reminders: list[ReminderOut]


class ReminderActionRequest(BaseModel):
    """Snooze or dismiss a reminder. Idempotent by ``action_id`` (also the `Idempotency-Key`).

    ``snooze`` needs exactly one of ``snooze_for_seconds`` (600, 3600 or 10800) and ``until``
    (``tomorrow_morning``: 09:00 the next day in the task's zone, computed by the server);
    ``dismiss`` takes neither. ``base_revision`` is the reminder revision the device acted on: an
    older one is accepted (an action is intent, not a field edit) and flagged ``stale``; one ahead
    of the server's is ``409 revision_ahead``.

    ``acted_at`` (R-68) is when the owner acted, by the device clock, ISO-8601 with an offset. A
    device that queued the action offline sends it so the snooze counts from the tap and not from
    the sync. The server clamps it to ``[now - 24 h, now + 5 min]`` (an out-of-range value is
    clamped, not refused), never orders actions by it and does not store it.
    """

    action_id: uuid.UUID
    kind: Literal["snooze", "dismiss"]
    snooze_for_seconds: Literal[600, 3600, 10800] | None = None
    until: Literal["tomorrow_morning"] | None = None
    base_revision: int | None = Field(default=None, ge=1)
    acted_at: AwareDatetime | None = Field(
        default=None,
        description="When the owner acted (device clock, with an offset). Clamped by the server.",
    )

    @model_validator(mode="after")
    def _shape(self) -> ReminderActionRequest:
        given = (self.snooze_for_seconds is not None) + (self.until is not None)
        if self.kind == "snooze" and given != 1:
            msg = "snooze needs exactly one of snooze_for_seconds and until"
            raise ValueError(msg)
        if self.kind == "dismiss" and given:
            msg = "dismiss takes no snooze duration"
            raise ValueError(msg)
        return self


class ReminderActionOut(BaseModel):
    reminder: ReminderOut
    applied: bool = Field(
        description="False when the reminder was cancelled: nothing changed (still 200)."
    )
    stale: bool = Field(
        description="The action was based on an older revision; re-reconcile from `reminder`."
    )


class HomeTimeZone(BaseModel):
    """The owner's home time zone (ADR-0068 Q6): the IANA zone used when a task has none.

    ``null`` keeps the historic behaviour (UTC). Changing it re-computes the reminders of tasks
    that have no zone of their own.
    """

    time_zone: str | None = Field(default=None, max_length=64)

    @field_validator("time_zone")
    @classmethod
    def _known(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if not value or not is_valid_time_zone(value):
            msg = "unknown IANA time zone"
            raise ValueError(msg)
        return value


# --- Live updates and sync hints (M8-04e; SYNC_PROTOCOL.md 14.7, 14.8) ----------------


class SyncWaitOut(BaseModel):
    """The answer of the long poll: a hint, never data. Compare ``head`` with your cursor."""

    head: int = Field(description="The caller's last allocated feed cursor.")
    changed: bool = Field(description="True when `head` differs from `since`; pull then.")


class HintRegisterRequest(BaseModel):
    """Register this device's UnifiedPush endpoint (a topic URL on the operator's gateway)."""

    kind: Literal["unifiedpush"] = "unifiedpush"
    endpoint: str = Field(min_length=1, max_length=512)


class HintStatusOut(BaseModel):
    """This device's hint destination. The endpoint is a secret: only its last 4 characters."""

    enabled: bool = Field(description="The server has sync hints switched on and a usable gateway.")
    registered: bool
    kind: str | None = None
    endpoint_tail: str | None = None
    last_ok_at: datetime | None = None
    last_error_class: str | None = None
    failures: int = 0
    invalid: bool = Field(
        default=False, description="The gateway forgot the topic; register a fresh endpoint."
    )


class HintTestOut(BaseModel):
    outcome: Literal["delivered", "invalid", "retry", "failed"]
    error_class: str | None = None


# --- Unified search (MU-05) ----------------------------------------------


class SearchNoteOut(BaseModel):
    """A matching note: identity and location only, never its content."""

    id: uuid.UUID
    path: str
    title: str


class SearchTaskOut(BaseModel):
    id: uuid.UUID
    title: str
    status: str
    priority: str
    due_at: datetime | None
    project_id: uuid.UUID | None


class SearchProjectOut(BaseModel):
    id: uuid.UUID
    name: str
    status: str


class SearchOut(BaseModel):
    """Up to ``limit`` hits of each kind, best match first (open work before closed)."""

    query: str
    notes: list[SearchNoteOut]
    tasks: list[SearchTaskOut]
    projects: list[SearchProjectOut]
