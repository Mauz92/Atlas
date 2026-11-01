"""Create or drop the throwaway PostgreSQL database used by the real-stack journey harness (MU-00).

Usage: python db_admin.py create|drop <admin-url> <database-name>

``admin-url`` is a libpq URL to an existing maintenance database (normally ``postgres``). Only
databases named ``atlas_e2e_*`` can be created or dropped, so the app's own databases (``atlas``,
``atlas_test``) can never be touched by this script.
"""

from __future__ import annotations

import re
import sys

import psycopg
from psycopg import sql


def main() -> int:
    action, admin_url, name = sys.argv[1:4]
    if not re.fullmatch(r"atlas_e2e_[a-z0-9_]+", name):
        print(
            f"refusing to touch database {name!r}: not an atlas_e2e_* name",
            file=sys.stderr,
        )
        return 2
    with psycopg.connect(admin_url, autocommit=True) as conn:
        if action == "create":
            conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
        elif action == "drop":
            conn.execute(
                sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(
                    sql.Identifier(name)
                )
            )
        else:
            print(f"unknown action {action!r}", file=sys.stderr)
            return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
