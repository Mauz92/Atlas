"""Markdown scaffolds for campaign notes, and extraction of the written handoff."""

from __future__ import annotations

import re

HANDOFF_HEADING = "Next session"

SESSION_HEADINGS = (
    "Where we left off",
    "Book references",
    "Prep",
    "During play",
    HANDOFF_HEADING,
)


def home_note(title: str, book_title: str | None) -> str:
    lines = [f"# {title}", ""]
    if book_title:
        lines += [f"Book: {book_title}", ""]
    lines += [
        "## Overview",
        "",
        "## Sessions",
        "",
        "Session notes live in the `Sessions/` folder; NPC and location notes go in `NPCs/` and",
        "`Locations/`.",
        "",
    ]
    return "\n".join(lines)


def session_note(title: str, left_off: str | None = None) -> str:
    """A new session note. ``left_off`` copies the previous session's handoff forward."""
    parts = [f"# {title}", ""]
    for heading in SESSION_HEADINGS:
        parts += [f"## {heading}", ""]
        if heading == "Where we left off" and left_off:
            parts += [left_off.strip(), ""]
    return "\n".join(parts)


_HEADING = re.compile(r"^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$")


def extract_section(content: str, heading: str) -> str | None:
    """The text under ``## <heading>`` up to the next heading of the same or higher level.

    Case-insensitive; the first match wins; fenced code blocks are skipped so a ``#`` inside one is
    never taken for a heading. Returns ``None`` when there is no such heading and ``""`` when the
    section is empty.
    """
    wanted = heading.strip().casefold()
    level: int | None = None
    collected: list[str] = []
    in_fence = False
    for line in content.splitlines():
        if line.lstrip().startswith(("```", "~~~")):
            in_fence = not in_fence
            if level is not None:
                collected.append(line)
            continue
        match = None if in_fence else _HEADING.match(line)
        if level is None:
            if match and match.group(2).strip().casefold() == wanted:
                level = len(match.group(1))
            continue
        if match and len(match.group(1)) <= level:
            break
        collected.append(line)
    if level is None:
        return None
    return "\n".join(collected).strip()
