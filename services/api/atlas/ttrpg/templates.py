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


def _sections(*items: tuple[str, str | None]) -> list[str]:
    """Headings, each with an optional one-line prompt in italics, as lines of Markdown."""
    lines: list[str] = []
    for heading, hint in items:
        lines += [f"## {heading}", ""]
        if hint:
            lines += [f"*{hint}*", ""]
    return lines


def home_note(title: str, book_title: str | None) -> str:
    lines = [f"# {title}", ""]
    if book_title:
        lines += [f"Book: {book_title}", ""]
    lines += _sections(
        ("Premise", "The pitch in two or three sentences: who the party are and what is at stake."),
        (
            "Tone and table rules",
            "Themes, content lines, house rules, how the group likes to play.",
        ),
        ("The party", "Who is at the table, with a one-line hook for each character."),
        ("Open threads", "Mysteries, promises, debts and villains' plans that are still moving."),
        ("Factions and key NPCs", "Who wants what. Link the NPC notes here."),
    )
    lines += [
        "## Sessions",
        "",
        "Session notes live in the `Sessions/` folder; NPC and location notes go in `NPCs/` and",
        "`Locations/`.",
        "",
    ]
    return "\n".join(lines)


def npc_note(name: str) -> str:
    return "\n".join(
        [
            f"# {name}",
            "",
            "Role: · Where: · Attitude:",
            "",
            *_sections(
                ("Who they are", "Look, voice, manner: what the players notice first."),
                ("What they want", "Their goal, and what they would do to get it."),
                ("Secrets", "What they hide, and who else knows."),
                ("Relationships", "Allies, rivals and debts. Link other notes."),
                ("Stats", "Link or name the creature card to use, with any changes."),
                ("Notes", None),
            ),
        ]
    )


def location_note(name: str) -> str:
    return "\n".join(
        [
            f"# {name}",
            "",
            *_sections(
                ("What it looks like", "Sights, sounds and smells on arrival."),
                ("Who is here", "Inhabitants and creatures; link their notes."),
                ("Secrets and hazards", "Hidden doors, traps, treasure, what is not as it seems."),
                ("Connected to", "Exits, nearby places and the threads that lead here."),
                ("Notes", None),
            ),
        ]
    )


def plain_note(name: str) -> str:
    return "\n".join([f"# {name}", "", "## Notes", ""])


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
