"""``atlas-admin`` — operator account recovery.

    atlas-admin list-users
    atlas-admin reset-password --email EMAIL
    atlas-admin list-devices --email EMAIL
    atlas-admin revoke-device --email EMAIL [--device ID | --all]
    atlas-admin record-restore

An **operator** tool (like ``atlas-backup``): it runs on the server with access to the database,
so it is not reachable over the network. The new password is read from a hidden prompt (or from
stdin when piped), never from an argument, so it cannot end up in shell history or the process
list. Resetting revokes **every** session and **every** device token of the account. Nothing
secret is printed or logged.
"""

from __future__ import annotations

import argparse
import asyncio
import getpass
import sys
import uuid
from datetime import UTC, datetime

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import AuthSession, Device, User
from .devices import revoke_all_devices, revoke_device
from .passwords import hash_password

MIN_PASSWORD_LENGTH = 12
MAX_PASSWORD_LENGTH = 1024


class ResetError(Exception):
    """The reset was refused; the message is safe to show."""


async def reset_password(session: AsyncSession, email: str, new_password: str) -> tuple[int, int]:
    """Set a new password; revoke all sessions and all device tokens.

    Returns ``(sessions revoked, devices revoked)``.
    """
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
    devices = await revoke_all_devices(session, user.id)
    return len(revoked.all()), devices


async def _find_user(session: AsyncSession, email: str) -> User:
    user = await session.scalar(select(User).where(func.lower(User.email) == email.strip().lower()))
    if user is None:
        raise ResetError("no such account")
    return user


async def list_devices(session: AsyncSession, email: str) -> list[Device]:
    user = await _find_user(session, email)
    rows = await session.execute(
        select(Device).where(Device.user_id == user.id).order_by(Device.created_at, Device.id)
    )
    return list(rows.scalars())


async def revoke_devices(
    session: AsyncSession, email: str, *, device_id: uuid.UUID | None, everything: bool
) -> int:
    """Revoke one device (``device_id``) or all of the account's (``everything``)."""
    user = await _find_user(session, email)
    if everything:
        return await revoke_all_devices(session, user.id)
    if device_id is None or not await revoke_device(session, user.id, device_id):
        raise ResetError("no such device for this account")
    return 1


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="atlas-admin", description="Atlas account recovery.")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("list-users", help="list account emails")
    reset = commands.add_parser("reset-password", help="set a new password for an account")
    reset.add_argument("--email", required=True, help="the account email")
    listing = commands.add_parser("list-devices", help="list an account's sync devices")
    listing.add_argument("--email", required=True, help="the account email")
    revoke = commands.add_parser(
        "revoke-device", help="sign sync devices out (token stops working)"
    )
    revoke.add_argument("--email", required=True, help="the account email")
    which = revoke.add_mutually_exclusive_group(required=True)
    which.add_argument("--device", type=uuid.UUID, help="the device id (see list-devices)")
    which.add_argument("--all", action="store_true", help="every device of the account")
    commands.add_parser(
        "record-restore",
        help="run after restoring a backup: tell sync clients the server went back in time",
    )
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
        sessions, devices = await reset_password(session, email, password)
    print(f"password reset; {sessions} session(s) and {devices} device(s) signed out")
    return 0


async def _list_devices(email: str) -> int:
    from ..db import session_scope

    async with session_scope() as session:
        devices = await list_devices(session, email)
    for device in devices:
        seen = device.last_seen_at.isoformat(timespec="minutes") if device.last_seen_at else "never"
        state = "revoked" if device.revoked_at else "active"
        print(f"{device.id}  {state:7}  {device.platform:8}  last seen {seen}  {device.name}")
    return 0


async def _revoke_devices(email: str, device_id: uuid.UUID | None, everything: bool) -> int:
    from ..db import session_scope

    async with session_scope() as session:
        count = await revoke_devices(session, email, device_id=device_id, everything=everything)
    print(f"{count} device(s) signed out")
    return 0


async def _record_restore() -> int:
    from ..db import session_scope
    from ..sync.epoch import rotate_epoch

    async with session_scope() as session:
        await rotate_epoch(session)
    print(
        "restore recorded: sync clients will be told this server's history changed and will "
        "ask their users before they sync again"
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        if args.command == "list-users":
            return asyncio.run(_list_users())
        if args.command == "list-devices":
            return asyncio.run(_list_devices(args.email))
        if args.command == "revoke-device":
            return asyncio.run(_revoke_devices(args.email, args.device, args.all))
        if args.command == "record-restore":
            return asyncio.run(_record_restore())
        return asyncio.run(_reset(args.email, _read_password()))
    except ResetError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
