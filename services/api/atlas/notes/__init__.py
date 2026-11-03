"""Markdown notes: storage, parsing, indexing, search and reconciliation."""

from .history import HistoryEntry, NoteHistory
from .markdown import ParsedNote, extract_links, extract_tags, extract_title, parse
from .merge import MergeResult, merge3
from .portable import PortablePathError, check_portable, fold
from .reconcile import NotesReconciler, ReconcileSummary
from .service import (
    NoteConflictError,
    NoteCreated,
    NoteDeletedError,
    NoteEditWinsError,
    NoteIdExistsError,
    NoteNotFoundError,
    NotePathConflictError,
    NoteResolution,
    NotesService,
    NoteSummary,
    NoteWrite,
    NoteWriteConflictError,
)
from .storage import (
    MAX_NOTE_BYTES,
    NOTE_SUFFIX,
    NoteFile,
    NotesStorage,
    NoteTooLargeError,
    UnsafePathError,
    content_hash,
    normalize_note_path,
    normalize_rel_path,
)
from .templates import DAILY_DIR, TEMPLATES_DIR, TemplateError, parse_day, render_template

__all__ = [
    "DAILY_DIR",
    "MAX_NOTE_BYTES",
    "NOTE_SUFFIX",
    "TEMPLATES_DIR",
    "HistoryEntry",
    "MergeResult",
    "NoteConflictError",
    "NoteCreated",
    "NoteDeletedError",
    "NoteEditWinsError",
    "NoteFile",
    "NoteHistory",
    "NoteIdExistsError",
    "NoteNotFoundError",
    "NotePathConflictError",
    "NoteResolution",
    "NoteSummary",
    "NoteTooLargeError",
    "NoteWrite",
    "NoteWriteConflictError",
    "NotesReconciler",
    "NotesService",
    "NotesStorage",
    "ParsedNote",
    "PortablePathError",
    "ReconcileSummary",
    "TemplateError",
    "UnsafePathError",
    "check_portable",
    "content_hash",
    "extract_links",
    "extract_tags",
    "extract_title",
    "fold",
    "merge3",
    "normalize_note_path",
    "normalize_rel_path",
    "parse",
    "parse_day",
    "render_template",
]
