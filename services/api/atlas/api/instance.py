"""Read-only instance information for the Settings page (MU-08, ADR-0050).

Authenticated, because it reveals deployment details (version, migration revision, backup state),
though never a secret, a path or a connection string.
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter
from sqlalchemy import select, text

from .. import __version__
from ..backups.status import read_destination_status
from ..changes.feed import MAX_CHANGE_LIMIT
from ..config import get_settings
from ..jobs import BACKUP_TASK
from ..models import Job
from ..sync.epoch import get_epoch
from ..sync.protocol import ENTITY_SCHEMAS, MAX_DATA_LIMIT, PROTOCOL_MAX, PROTOCOL_MIN
from .deps import DbSession, SyncUser
from .schemas import (
    BackupLatest,
    BackupStatus,
    InstanceInfo,
    InstanceSync,
    SyncLimits,
    SyncProtocolRange,
)

router = APIRouter(prefix="/api/instance", tags=["instance"])


@router.get("", response_model=InstanceInfo)
async def instance_info(_user: SyncUser, session: DbSession) -> InstanceInfo:
    settings = get_settings()
    database = "ok"
    revision: str | None = None
    try:
        revision = await session.scalar(text("SELECT version_num FROM alembic_version LIMIT 1"))
    except Exception:  # status must never raise; a missing table is reported as no revision
        await session.rollback()
    last_job = (
        await session.execute(
            select(Job.status, Job.updated_at)
            .where(Job.task_name == BACKUP_TASK, Job.status.in_(("succeeded", "failed", "running")))
            .order_by(Job.updated_at.desc())
            .limit(1)
        )
    ).first()
    destination = await asyncio.to_thread(read_destination_status, settings.backup_dir)
    latest = destination.latest
    epoch = await get_epoch(session)
    await session.commit()  # a first read may have created the epoch row
    return InstanceInfo(
        version=__version__,
        environment=settings.atlas_env,
        database=database,
        migration_revision=revision,
        web_push_configured=bool(
            settings.vapid_public_key and settings.vapid_private_key and settings.vapid_subject
        ),
        sync=InstanceSync(
            protocol=SyncProtocolRange(min=PROTOCOL_MIN, max=PROTOCOL_MAX),
            entities=dict(ENTITY_SCHEMAS),
            limits=SyncLimits(
                max_note_bytes=5 * 1024 * 1024,
                feed_page_max=MAX_CHANGE_LIMIT,
                feed_page_max_with_data=MAX_DATA_LIMIT,
            ),
            tombstone_retention_days=settings.change_retention_days,
            idempotency_retention_days=settings.change_retention_days,
            epoch=epoch,
        ),
        backups=BackupStatus(
            destination_available=destination.available,
            sets=destination.sets,
            latest=BackupLatest(
                backup_id=latest.backup_id,
                created_at=latest.created_at,
                atlas_version=latest.atlas_version,
                database_bytes=latest.database_bytes,
                notes_bytes=latest.notes_bytes,
            )
            if latest
            else None,
            incomplete_sets=destination.incomplete,
            interval_seconds=settings.backup_interval_seconds,
            retain=settings.backup_retain,
            last_job_status=last_job[0] if last_job else None,
            last_job_at=last_job[1] if last_job else None,
        ),
    )
