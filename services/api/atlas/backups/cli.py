"""``atlas-backup`` — run and verify Atlas backups from an operator's shell or a scheduler.

    atlas-backup run [--destination DIR] [--retain N]
    atlas-backup verify [PATH]
    atlas-backup list [PATH]

Exit code is ``0`` on success and non-zero on a failed backup or a set that does not verify, so a
scheduler can act on it. Nothing secret is printed: the manifest and these summaries contain only
timestamps, counts, sizes and checksums (AGENTS.md §11).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from ..config import get_settings
from .manifest import MANIFEST_NAME
from .service import BackupConfig, BackupError, BackupService
from .verify import list_backup_sets, list_incomplete_sets, verify_backup_set


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="atlas-backup",
        description="Create and verify Atlas backups (PostgreSQL + Markdown notes).",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    run = subparsers.add_parser("run", help="produce one backup set")
    run.add_argument("--destination", help="override BACKUP_DIR")
    run.add_argument("--retain", type=int, help="override BACKUP_RETAIN")

    verify = subparsers.add_parser("verify", help="verify a set, or every set in a destination")
    verify.add_argument("path", nargs="?", help="a backup set directory, or a destination")

    listing = subparsers.add_parser("list", help="list published sets in a destination")
    listing.add_argument("path", nargs="?", help="a destination directory")

    return parser


def _resolve_target(argument: str | None) -> Path:
    settings = get_settings()
    return Path(argument) if argument else Path(settings.backup_dir).expanduser()


def _run(args: argparse.Namespace) -> int:
    settings = get_settings()
    config = BackupConfig(
        destination=Path(args.destination).expanduser()
        if args.destination
        else Path(settings.backup_dir).expanduser(),
        notes_root=Path(settings.notes_root).expanduser(),
        database_url=settings.database_url,
        retain=args.retain or settings.backup_retain,
        pg_dump_binary=settings.backup_pg_dump_binary,
        pg_dump_container=settings.backup_pg_dump_container,
    )
    try:
        result = BackupService(config).run()
    except (BackupError, OSError) as exc:
        print(f"backup failed: {exc}", file=sys.stderr)
        return 1
    print(f"backup ok: {result.backup_id}")
    print(f"  directory: {result.directory}")
    print(f"  database: {result.database_bytes} bytes sha256={result.database_sha256}")
    print(
        f"  notes: {result.notes_bytes} bytes ({result.notes_files} files) "
        f"sha256={result.notes_sha256}"
    )
    return 0


def _verify(args: argparse.Namespace) -> int:
    target = _resolve_target(args.path)
    if (target / MANIFEST_NAME).is_file():
        sets = [target]
        destination = target.parent
    else:
        sets = list_backup_sets(target)
        destination = target

    ok = True
    if not sets:
        print(f"no backup sets found in {target}", file=sys.stderr)
        ok = False
    for set_dir in sets:
        verification = verify_backup_set(set_dir)
        label = "ok" if verification.ok else "FAILED"
        print(f"{label} {set_dir}")
        for part in verification.parts:
            print(f"    {part.name}: {part.detail}")
        for error in verification.errors:
            print(f"    error: {error}", file=sys.stderr)
        ok = ok and verification.ok

    for leftover in list_incomplete_sets(destination):
        print(f"INCOMPLETE {leftover} (interrupted run; no manifest)", file=sys.stderr)
        ok = False
    return 0 if ok else 1


def _list(args: argparse.Namespace) -> int:
    destination = _resolve_target(args.path)
    sets = list_backup_sets(destination)
    if not sets:
        print(f"no backup sets found in {destination}")
    for set_dir in sets:
        verification = verify_backup_set(set_dir)
        print(f"{'ok' if verification.ok else 'FAILED'} {set_dir.name}")
    for leftover in list_incomplete_sets(destination):
        print(f"INCOMPLETE {leftover.name}")
    return 0 if all(verify_backup_set(s).ok for s in sets) else 1


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    if args.command == "run":
        return _run(args)
    if args.command == "verify":
        return _verify(args)
    return _list(args)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
