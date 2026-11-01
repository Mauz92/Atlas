"""Full data export API (M9-03).

``GET /api/export`` returns the authenticated caller's **entire** workspace — notes, tasks and
projects (with their associations) — as a single ``application/zip`` download. The archive is a
complete *export set*: it contains the real Markdown files under ``notes/``, the versioned
``atlas.project-export`` document (M4-07) in ``data.json``, the notes metadata index in
``notes.json`` and a ``manifest.json`` listing every file with its size and SHA-256. The set layout
and its version contract are documented in ``DECISIONS.md`` ADR-0026/ADR-0042.

The endpoint is read-only and **strictly user-scoped**: it exports exactly the caller's own rows
(every query filters on the authenticated user's id), so another account's data can never appear.
The whole snapshot is read as one consistent point in time (the M4-07 REPEATABLE READ approach), so
it cannot tear. The identical set can be produced on the server with the ``atlas-export`` CLI.
"""

from __future__ import annotations

import io
import tempfile
from pathlib import Path

from fastapi import APIRouter, Response

from ..export import ExportService, zip_export_set
from .deps import CurrentUser, DbSession
from .notes import StorageDep

router = APIRouter(prefix="/api/export", tags=["export"])


@router.get(
    "",
    response_class=Response,
    responses={
        200: {
            "content": {"application/zip": {}},
            "description": (
                "A complete export set (notes/ + data.json + notes.json + manifest.json) as a zip."
            ),
        }
    },
)
async def export_workspace(user: CurrentUser, session: DbSession, storage: StorageDep) -> Response:
    """Download the caller's full data export as a zip (M9-03, REQ-015).

    The archive holds the user's real Markdown notes, their tasks and projects (the versioned M4-07
    document plus the tasks filed under no project) and a checksummed manifest. It is a portability
    artifact — everything a third-party tool needs to read the workspace without Atlas — not a
    backup; for disaster recovery use the M9-01 backup sets / M9-02 restore procedure.
    """
    service = ExportService(session, user.id, storage)
    with tempfile.TemporaryDirectory(prefix="atlas-export-") as tmp:
        result = await service.build_set(Path(tmp) / "export")
        buffer = io.BytesIO()
        root = f"atlas-export-{result.export_id}"
        zip_export_set(result.directory, buffer, root=root)
        payload = buffer.getvalue()
    filename = f"{root}.zip"
    return Response(
        content=payload,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
