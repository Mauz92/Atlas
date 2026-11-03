"""Instance-wide key/value facts (SYNC-03b).

Today it holds one row: ``epoch``, the UUID that identifies *this database's history* to sync
clients (``SYNC_PROTOCOL.md`` section 10.2). It is created by the migration, so every install has
one from the start, and it is rotated by the operator after a restore from backup
(``atlas-admin record-restore``; ADR-0059 D12) so that clients notice that the server went back in
time even when its cursor has since grown past theirs.
"""

from __future__ import annotations

from sqlalchemy import String, Text
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base


class InstanceMeta(Base):
    __tablename__ = "instance_meta"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[str] = mapped_column(Text, nullable=False)
