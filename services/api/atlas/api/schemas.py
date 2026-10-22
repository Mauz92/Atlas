"""Request and response schemas."""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field

from ..models import TaskPriority, TaskStatus


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=1024)


class SetupRequest(BaseModel):
    email: EmailStr
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


class TaskOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

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


class TaskListOut(BaseModel):
    tasks: list[TaskOut]
