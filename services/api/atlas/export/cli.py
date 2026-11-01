"""``atlas-export`` — produce and verify a full, portable Atlas data export (M9-03).

    atlas-export run --user EMAIL [--destination DIR]
    atlas-export verify [PATH]
    atlas-export list [PATH]

This is an **operator** tool (like ``atlas-backup``): it runs on the server and names the user whose
workspace to export, so it is not reachable over the network. The authenticated per-user equivalent
is ``GET /api/export``. Exit code is ``0`` on success and non-zero on a failed export or a set that
does not verify, so a scheduler can act on it. Nothing secret is printed.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

from sqlalchemy import func, select

from ..config import get_settings
from ..notes import NotesStorage
from .document import MANIFEST_NAME, SET_PREFIX, STAGING_DIR
from .service import ExportError, ExportService
from .verify import list_export_sets, list_incomplete_sets, verify_export_set


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="atlas-export",
        description="Export a user's Atlas data (notes + tasks + projects) in open formats.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    run = subparsers.add_parser("run", help="produce one export set for a user")
    subject = run.add_mutually_exclusive_group(required=True)
    subject.add_argument("--user", help="the account email to export")
    subject.add_argument("--user-id", help="the account UUID to export")
    run.add_argument("--destination", help="override EXPORT_DIR")

    verify = subparsers.add_parser("verify", help="verify a set, or every set in a destination")
    verify.add_argument("path", nargs="?", help="an export set directory, or a destination")

    listing = subparsers.add_parser("list", help="list published sets in a destination")
    listing.add_argument("path", nargs="?", help="a destination directory")

    return parser


def _resolve_target(argument: str | None) -> Path:
    settings = get_settings()
    return Path(argument) if argument else Path(settings.export_dir).expanduser()


async def _export(email: str | None, user_id: str | None, destination: Path) -> int:
    import uuid as _uuid

    from ..db import session_scope
    from ..models import User

    async with session_scope() as session:
        if user_id is not None:
            try:
                wanted = _uuid.UUID(user_id)
            except ValueError:
                print(f"not a valid user id: {user_id}", file=sys.stderr)
                return 1
            user = await session.get(User, wanted)
        else:
            user = await session.scalar(
                select(User).where(func.lower(User.email) == (email or "").lower())
            )
        if user is None or not user.is_active:
            print("no such active account", file=sys.stderr)
            return 1

        storage = NotesStorage(get_settings().notes_root)
        destination.mkdir(parents=True, exist_ok=True)
        staging = destination / STAGING_DIR
        staging.mkdir(parents=True, exist_ok=True)
        staging_target = staging / f"export-{_uuid.uuid4().hex[:8]}"

        try:
            result = await ExportService(session, user.id, storage).build_set(staging_target)
        except (ExportError, OSError) as exc:
            print(f"export failed: {exc}", file=sys.stderr)
            return 1

        published = destination / f"{SET_PREFIX}{result.export_id}"
        os.replace(result.directory, published)

    print(f"export ok: {result.export_id}")
    print(f"  directory: {published}")
    print(
        f"  projects: {result.projects}  tasks: {result.tasks}  notes: {result.notes}  "
        f"note-project links: {result.note_project_links}"
    )
    print(f"  files: {len(result.manifest['files'])}")
    return 0


def _run(args: argparse.Namespace) -> int:
    destination = (
        Path(args.destination).expanduser()
        if args.destination
        else Path(get_settings().export_dir).expanduser()
    )
    return asyncio.run(_export(args.user, args.user_id, destination))


def _verify(args: argparse.Namespace) -> int:
    target = _resolve_target(args.path)
    if (target / MANIFEST_NAME).is_file():
        sets = [target]
        destination = target.parent
    else:
        sets = list_export_sets(target)
        destination = target

    ok = True
    if not sets:
        print(f"no export sets found in {target}", file=sys.stderr)
        ok = False
    for set_dir in sets:
        verification = verify_export_set(set_dir)
        print(f"{'ok' if verification.ok else 'FAILED'} {set_dir}")
        for error in verification.errors:
            print(f"    error: {error}", file=sys.stderr)
        ok = ok and verification.ok

    for leftover in list_incomplete_sets(destination):
        print(f"INCOMPLETE {leftover} (interrupted run; no manifest)", file=sys.stderr)
        ok = False
    return 0 if ok else 1


def _list(args: argparse.Namespace) -> int:
    destination = _resolve_target(args.path)
    sets = list_export_sets(destination)
    if not sets:
        print(f"no export sets found in {destination}")
    for set_dir in sets:
        verification = verify_export_set(set_dir)
        print(f"{'ok' if verification.ok else 'FAILED'} {set_dir.name}")
    for leftover in list_incomplete_sets(destination):
        print(f"INCOMPLETE {leftover.name}")
    return 0 if all(verify_export_set(s).ok for s in sets) else 1


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    if args.command == "run":
        return _run(args)
    if args.command == "verify":
        return _verify(args)
    return _list(args)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
