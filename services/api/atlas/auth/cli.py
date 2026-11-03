"""``atlas-admin`` — operator account recovery.

    atlas-admin list-users
    atlas-admin reset-password --email EMAIL

An **operator** tool (like ``atlas-backup``): it runs on the server with access to the database,
so it is not reachable over the network. The new password is read from a hidden prompt (or from
stdin when piped), never from an argument, so it cannot end up in shell history or the process
list. Resetting revokes **every** session of the account. Nothing secret is printed or logged.
"""

from __future__ import annotations

import argparse
import asyncio
import getpass
import sys
from datetime import UTC, datetime

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import AuthSession, User
from .passwords import hash_password

MIN_PASSWORD_LENGTH = 12
MAX_PASSWORD_LENGTH = 1024


class ResetError(Exception):
    """The reset was refused; the message is safe to show."""


async def reset_password(session: AsyncSession, email: str, new_password: str) -> int:
    """Set a new password and revoke all sessions. Returns the number of sessions revoked."""
    if not MIN_PASSWORD_LENGTH <= len(new_password) <= MAX_PASSWORD_LENGTH:
        raise ResetError(
            f"the password must be {MIN_PASSWORD_LENGTH} to {MAX_PASSWORD_LENGTH} characters"
        )
    user = await session.scalar(select(User).where(func.lower(User.email) == email.strip().lower()))
    if user is None or not user.is_active:
        raise ResetError("no such active account")
    user.password_hash = hash_password(new_password)
    revoked = await session.execute(
        update(AuthSession)
        .where(AuthSession.user_id == user.id, AuthSession.revoked_at.is_(None))
        .values(revoked_at=datetime.now(UTC))
        .returning(AuthSession.id)
    )
    return len(revoked.all())


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="atlas-admin", description="Atlas account recovery.")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("list-users", help="list account emails")
    reset = commands.add_parser("reset-password", help="set a new password for an account")
    reset.add_argument("--email", required=True, help="the account email")
    return parser


def _read_password() -> str:
    if not sys.stdin.isatty():
        return sys.stdin.readline().rstrip("\r\n")
    first = getpass.getpass("New password: ")
    if getpass.getpass("Repeat new password: ") != first:
        raise ResetError("the passwords do not match")
    return first


async def _list_users() -> int:
    from ..db import session_scope

    async with session_scope() as session:
        rows = (await session.execute(select(User.email, User.is_active))).all()
    for email, active in rows:
        print(f"{email}{'' if active else '  (inactive)'}")
    return 0


async def _reset(email: str, password: str) -> int:
    from ..db import session_scope

    async with session_scope() as session:
        revoked = await reset_password(session, email, password)
    print(f"password reset; {revoked} session(s) signed out")
    return 0


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        if args.command == "list-users":
            return asyncio.run(_list_users())
        return asyncio.run(_reset(args.email, _read_password()))
    except ResetError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
