"""Worker process entry point (``atlas-worker``)."""

from __future__ import annotations

from .jobs.worker import main

__all__ = ["main"]
