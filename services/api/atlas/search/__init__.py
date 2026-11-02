"""Unified search across notes, tasks and projects (MU-05, ADR-0047)."""

from .service import (
    MAX_QUERY_LENGTH,
    SearchResults,
    SearchService,
    prefix_tsquery,
)

__all__ = ["MAX_QUERY_LENGTH", "SearchResults", "SearchService", "prefix_tsquery"]
