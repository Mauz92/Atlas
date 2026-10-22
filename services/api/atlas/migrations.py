"""Programmatic migration entry point (``atlas-migrate``)."""

from __future__ import annotations

import os
from pathlib import Path

from alembic import command
from alembic.config import Config


def _find_ini() -> Path:
    """Locate ``alembic.ini`` for both editable and installed layouts.

    The package may be installed into site-packages (container) or consumed from the
    source tree (editable/local), and the process working directory differs in each case.
    """
    candidates: list[Path] = []
    override = os.environ.get("ATLAS_ALEMBIC_INI")
    if override:
        candidates.append(Path(override))
    candidates.append(Path.cwd() / "alembic.ini")
    candidates.append(Path(__file__).resolve().parent.parent / "alembic.ini")
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    msg = "alembic.ini not found; set ATLAS_ALEMBIC_INI to its path"
    raise FileNotFoundError(msg)


def _config() -> Config:
    ini = _find_ini()
    cfg = Config(str(ini))
    cfg.set_main_option("script_location", str(ini.parent / "alembic"))
    return cfg


def upgrade(revision: str = "head") -> None:
    command.upgrade(_config(), revision)


def downgrade(revision: str = "base") -> None:
    command.downgrade(_config(), revision)


def main() -> None:
    upgrade()


if __name__ == "__main__":  # pragma: no cover
    main()
