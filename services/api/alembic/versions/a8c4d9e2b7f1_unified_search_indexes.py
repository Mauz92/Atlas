"""unified search: full-text indexes on tasks and projects (MU-05)

Revision ID: a8c4d9e2b7f1
Revises: f1b2c3d4e5a6
Create Date: 2026-11-02

Adds two GIN expression indexes so ``GET /api/search`` (ADR-0047) finds tasks and projects by
word prefix without scanning every row of the user (resolves R-20 for the search path):

* ``ix_tasks_search_fts``    on ``to_tsvector('simple', title || ' ' || description)``

* ``ix_projects_search_fts`` on ``to_tsvector('simple', name  || ' ' || description)``

The expressions are written in PostgreSQL's canonical printed form (so autogenerate sees no drift)
and copied literally from ``atlas.models.task.TASK_SEARCH_VECTOR`` and
``atlas.models.project.PROJECT_SEARCH_VECTOR`` (a migration must stay frozen even if the models
change). Notes already have ``ix_notes_search_vector``. The change is additive: no column, no data
and no existing index is touched, the indexes are built from existing rows, and the downgrade only
drops them. Plain (not ``CONCURRENTLY``) builds take a short write lock, which is acceptable at the
single-user scale (ADR-0018).
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a8c4d9e2b7f1"
down_revision: str | None = "f1b2c3d4e5a6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TASK_VECTOR = (
    "to_tsvector('simple'::regconfig, (COALESCE(title, ''::character varying)::text || ' '::text) "
    "|| COALESCE(description, ''::text))"
)
_PROJECT_VECTOR = (
    "to_tsvector('simple'::regconfig, (COALESCE(name, ''::character varying)::text || ' '::text) "
    "|| COALESCE(description, ''::text))"
)


def upgrade() -> None:
    op.create_index("ix_tasks_search_fts", "tasks", [sa.text(_TASK_VECTOR)], postgresql_using="gin")
    op.create_index(
        "ix_projects_search_fts", "projects", [sa.text(_PROJECT_VECTOR)], postgresql_using="gin"
    )


def downgrade() -> None:
    op.drop_index("ix_projects_search_fts", table_name="projects")
    op.drop_index("ix_tasks_search_fts", table_name="tasks")
