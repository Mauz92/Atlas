"""Full data export (M9-03): notes + tasks + projects in open formats, with a manifest.

See :mod:`atlas.export.document` for the set layout and the versioned format contract, and
:class:`atlas.export.service.ExportService` for the implementation. Reachable through
``GET /api/export`` (an authenticated user's own data) and the ``atlas-export`` CLI (an operator
tool).
"""

from .document import (
    DATA_FILENAME,
    DATA_FORMAT,
    DATA_VERSION,
    EXPORT_FORMAT,
    EXPORT_VERSION,
    MANIFEST_NAME,
    NOTES_DIR,
    NOTES_INDEX_FILENAME,
    NOTES_INDEX_FORMAT,
    NOTES_INDEX_VERSION,
    SET_PREFIX,
    STAGING_DIR,
    ManifestError,
    build_manifest,
    build_notes_index,
    note_index_entry,
    note_link_document,
)
from .service import ExportError, ExportService, ExportSet, zip_export_set
from .verify import ExportVerification, FileCheck, verify_export_set

__all__ = [
    "DATA_FILENAME",
    "DATA_FORMAT",
    "DATA_VERSION",
    "EXPORT_FORMAT",
    "EXPORT_VERSION",
    "MANIFEST_NAME",
    "NOTES_DIR",
    "NOTES_INDEX_FILENAME",
    "NOTES_INDEX_FORMAT",
    "NOTES_INDEX_VERSION",
    "SET_PREFIX",
    "STAGING_DIR",
    "ExportError",
    "ExportService",
    "ExportSet",
    "ExportVerification",
    "FileCheck",
    "ManifestError",
    "build_manifest",
    "build_notes_index",
    "note_index_entry",
    "note_link_document",
    "verify_export_set",
    "zip_export_set",
]
