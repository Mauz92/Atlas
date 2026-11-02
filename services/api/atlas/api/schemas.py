"""Request and response schemas."""

from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Annotated

from email_validator import EmailNotValidError, validate_email
from pydantic import (
    AfterValidator,
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


class UserPublic(BaseModel):
    id: uuid.UUID
    email: str
    display_name: str


class SetupStatus(BaseModel):
    setup_required: bool


class HealthStatus(BaseModel):
    status: str
    version: str


class ReadyStatus(BaseModel):
    status: str
    database: str


# --- Notes ---------------------------------------------------------------


class NoteCreateRequest(BaseModel):
    path: str = Field(min_length=1, max_length=1024)
    content: str = Field(default="", max_length=5 * 1024 * 1024)


class NoteUpdateRequest(BaseModel):
    content: str = Field(max_length=5 * 1024 * 1024)
    base_revision: int = Field(ge=0)


class NoteConflictCopyRequest(BaseModel):
    content: str = Field(max_length=5 * 1024 * 1024)


class NoteMoveRequest(BaseModel):
    path: str = Field(min_length=1, max_length=1024)


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


class NoteDetailOut(NoteSummaryOut):
    content: str
    tags: list[str]
    links: list[NoteLinkOut]
    backlinks: list[NoteSummaryOut]
    unresolved_links: list[str]


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
    created_at: datetime
    updated_at: datetime


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
    """

    changes: list[ChangeOut]
    since: int
    next_since: int
    has_more: bool
    resync_required: bool = False


# --- Projects ------------------------------------------------------------


class ProjectCreateRequest(BaseModel):
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
    created_at: datetime
    updated_at: datetime


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
