"""Where and how to run ``pg_dump`` for a backup.

Two backends are supported, chosen explicitly (never guessed), so the same code works whether the
PostgreSQL client tools are installed next to Atlas (the container image) or live only inside the
database's own container (the local dev host):

* ``binary``    — run a local ``pg_dump`` and connect over TCP, or
* ``container`` — run ``pg_dump`` *inside* a Docker container (``docker exec``).

The database password, when present, is passed via ``PGPASSWORD`` in the child's environment and is
**never** placed on the command line, so it cannot leak through ``ps`` or a logged argv
(AGENTS.md §11).
"""

from __future__ import annotations

import shutil
import subprocess
from dataclasses import dataclass, field
from typing import Literal

from sqlalchemy import make_url

#: Plain-SQL dump: portable, human-readable, restorable with ``psql``, and uniformly checksummable.
#: Ownership/privileges are dropped so a restore needs no matching roles (see ADR-0041).
_DUMP_FLAGS = ("--no-owner", "--no-privileges", "--format=plain")


class PgDumpError(RuntimeError):
    """Raised when no usable ``pg_dump`` backend can be resolved."""


@dataclass(frozen=True)
class PgDumpBackend:
    kind: Literal["binary", "container"]
    target: str


@dataclass(frozen=True)
class PgDumpInvocation:
    #: argv (never contains the password).
    argv: list[str]
    #: Extra environment for the child (e.g. ``PGPASSWORD``); never logged.
    env: dict[str, str] = field(default_factory=dict)
    #: A log-safe rendering of the command.
    display: str = ""


def resolve_backend(*, binary: str = "pg_dump", container: str = "") -> PgDumpBackend:
    """Resolve the configured backend, probing that it actually works."""
    if container:
        probe = subprocess.run(
            ["docker", "exec", container, "pg_dump", "--version"],
            capture_output=True,
            text=True,
            check=False,
        )
        if probe.returncode != 0:
            detail = (probe.stderr or "").strip() or "docker exec failed"
            msg = f"cannot run pg_dump inside container {container!r}: {detail}"
            raise PgDumpError(msg)
        return PgDumpBackend(kind="container", target=container)
    path = shutil.which(binary)
    if path is None:
        msg = (
            f"pg_dump not found (looked for {binary!r}); install the PostgreSQL client tools "
            "or set BACKUP_PG_DUMP_CONTAINER to a container running PostgreSQL"
        )
        raise PgDumpError(msg)
    return PgDumpBackend(kind="binary", target=path)


def build_dump_argv(database_url: str, backend: PgDumpBackend) -> PgDumpInvocation:
    """Build the ``pg_dump`` invocation for ``database_url`` (password kept out of argv)."""
    url = make_url(database_url)
    username = url.username or "postgres"
    database = url.database or username
    if backend.kind == "container":
        argv = [
            "docker",
            "exec",
            backend.target,
            "pg_dump",
            *_DUMP_FLAGS,
            "-U",
            username,
            "-d",
            database,
        ]
        return PgDumpInvocation(argv=argv, env={}, display=" ".join(argv))
    argv = [backend.target, *_DUMP_FLAGS]
    if url.host:
        argv += ["--host", url.host]
    if url.port:
        argv += ["--port", str(url.port)]
    argv += ["--username", username, "--dbname", database]
    env = {"PGPASSWORD": url.password} if url.password else {}
    return PgDumpInvocation(argv=argv, env=env, display=" ".join(argv))
