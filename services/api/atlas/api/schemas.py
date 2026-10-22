"""Request and response schemas."""

from __future__ import annotations

import uuid

from pydantic import BaseModel, EmailStr, Field


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
