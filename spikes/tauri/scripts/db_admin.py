"""Create or drop the throwaway database of the SYNC-07 spike.

Usage: python db_admin.py create|drop <admin-url> <database-name>
Only names matching atlas_spike_* are accepted; `atlas` and `atlas_test` can never be touched.
"""
from __future__ import annotations

import re
import sys

import psycopg
from psycopg import sql


def main() -> int:
    action, admin_url, name = sys.argv[1:4]
    if not re.fullmatch(r"atlas_spike_[a-z0-9]+", name):
        print(f"refusing to touch database {name!r}", file=sys.stderr)
        return 2
    with psycopg.connect(admin_url, autocommit=True) as conn:
        if action == "create":
            conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
        elif action == "drop":
            conn.execute(sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(sql.Identifier(name)))
        else:
            return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
