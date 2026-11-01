"""Backup and operations (M9-01): one verifiable backup set covering both durable stores."""

from .manifest import (
    DATABASE_PART,
    FORMAT_NAME,
    FORMAT_VERSION,
    MANIFEST_NAME,
    NOTES_PART,
    REQUIRED_PARTS,
    ManifestError,
)
from .pgdump import PgDumpBackend, PgDumpError, PgDumpInvocation, build_dump_argv, resolve_backend
from .service import BackupConfig, BackupError, BackupResult, BackupService
from .verify import (
    BackupVerification,
    PartCheck,
    list_backup_sets,
    list_incomplete_sets,
    verify_backup_set,
)

__all__ = [
    "DATABASE_PART",
    "FORMAT_NAME",
    "FORMAT_VERSION",
    "MANIFEST_NAME",
    "NOTES_PART",
    "REQUIRED_PARTS",
    "BackupConfig",
    "BackupError",
    "BackupResult",
    "BackupService",
    "BackupVerification",
    "ManifestError",
    "PartCheck",
    "PgDumpBackend",
    "PgDumpError",
    "PgDumpInvocation",
    "build_dump_argv",
    "list_backup_sets",
    "list_incomplete_sets",
    "resolve_backend",
    "verify_backup_set",
]
