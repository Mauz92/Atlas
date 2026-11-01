"""Allow ``python -m atlas.export`` as an alternative to the ``atlas-export`` entry point."""

from __future__ import annotations

from .cli import main

if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
