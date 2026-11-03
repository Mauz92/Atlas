"""Three-way text merge for notes (SYNC-04, ADR-0055 rule 5, ADR-0059 D5).

``merge3(base, theirs, ours)`` merges two edits of one common ancestor, line by line, the way
``diff3`` does. It is deliberately conservative: the merge is *clean* only when every region
changed by one side is untouched by the other (or both made the same change). Anything else -
two edits that touch or overlap, an insertion at the same spot, a front-matter block that would
be assembled from two sides, a pathological input - is reported as not merged, and the caller
keeps both versions (a conflict copy). Merging is never a guess.

Implementation choice (AGENTS.md 7.5 / 14, recorded in ``DEPENDENCIES.md``): an in-repo
implementation on top of the standard library's ``difflib`` for the line matching, because
the maintained Python merge libraries are either copyleft (``merge3`` is GPL-2.0-or-later),
character based and fuzzy (``diff-match-patch`` patching), or wrappers around ``git``, which the
container does not carry. The merge logic itself is ~40 lines and is covered by property tests
(``tests/unit/test_note_merge.py``).

Exact-bytes semantics (the R-24 lesson):

* Lines are split on ``\\n`` only and keep their terminator, so a CRLF file keeps its ``\\r\\n`` on
  every line it contributes; no line is ever re-terminated. A lone ``\\r`` is part of its line.
* The *final newline* is merged separately (three-way on the "text ends with a newline" flag), so
  appending a line to a note that has no trailing newline merges with an edit elsewhere instead
  of conflicting on the last line.
* The result is whole lines taken verbatim from one of the inputs; UTF-8 text goes in and comes
  out untouched (including a BOM, which is simply part of the first line).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from difflib import SequenceMatcher

from .storage import MAX_NOTE_BYTES

#: Above this many lines (on any side) the merge is not attempted.
MAX_LINES = 200_000
#: Above this many cells (changed base lines x changed other lines) the diff is not attempted:
#: ``difflib`` is quadratic in the worst case and a request must stay cheap.
MAX_CELLS = 4_000_000

OVERLAP = "overlap"
FRONT_MATTER = "front_matter"
TOO_LARGE = "too_large"

_FRONT_MATTER = re.compile(r"\A---[ \t]*\r?\n.*?\r?\n---[ \t]*(?:\r?\n|\Z)", re.DOTALL)


@dataclass(frozen=True)
class MergeResult:
    """``text`` is the merged note, or ``None`` when the two edits cannot be combined safely;
    ``reason`` then says why (``overlap``, ``front_matter`` or ``too_large``)."""

    text: str | None
    reason: str | None = None

    @property
    def clean(self) -> bool:
        return self.text is not None


class _TooLargeError(Exception):
    pass


def _split(text: str) -> tuple[list[str], bool]:
    """``(lines, ends_with_newline)``: every line keeps its ``\\n``; an unterminated last line is
    given one for comparison and the flag remembers that it had none."""
    if not text:
        return [], True
    final = text.endswith("\n")
    parts = (text if final else text + "\n").split("\n")[:-1]
    return [part + "\n" for part in parts], final


def _match(base: list[str], other: list[str]) -> dict[int, int]:
    """Monotonic matching of equal lines: ``base index -> other index``."""
    n, m = len(base), len(other)
    prefix = 0
    while prefix < n and prefix < m and base[prefix] == other[prefix]:
        prefix += 1
    suffix = 0
    while (
        suffix < n - prefix
        and suffix < m - prefix
        and base[n - 1 - suffix] == other[m - 1 - suffix]
    ):
        suffix += 1
    pairs = {i: i for i in range(prefix)}
    mid_base, mid_other = base[prefix : n - suffix], other[prefix : m - suffix]
    if mid_base and mid_other:
        if len(mid_base) * len(mid_other) > MAX_CELLS:
            raise _TooLargeError
        matcher = SequenceMatcher(None, mid_base, mid_other, autojunk=False)
        for a, b, size in matcher.get_matching_blocks():
            for k in range(size):
                pairs[prefix + a + k] = prefix + b + k
    for k in range(suffix):
        pairs[n - suffix + k] = m - suffix + k
    return pairs


def _front_matter(text: str) -> str:
    match = _FRONT_MATTER.match(text)
    return match.group(0) if match else ""


def merge3(base: str, theirs: str, ours: str) -> MergeResult:
    """Merge ``theirs`` (the server's current text) and ``ours`` (the incoming edit), both
    derived from ``base``. See the module docstring for what "clean" means."""
    if theirs == ours or ours == base:
        return MergeResult(theirs)
    if theirs == base:
        return MergeResult(ours)

    b_lines, b_final = _split(base)
    t_lines, t_final = _split(theirs)
    o_lines, o_final = _split(ours)
    if max(len(b_lines), len(t_lines), len(o_lines)) > MAX_LINES:
        return MergeResult(None, TOO_LARGE)
    try:
        theirs_match = _match(b_lines, t_lines)
        ours_match = _match(b_lines, o_lines)
    except _TooLargeError:
        return MergeResult(None, TOO_LARGE)

    # Base lines that both sides kept are the anchors; between two anchors each side either left
    # the base region alone or replaced it, and exactly one side (or both, identically) may change.
    anchors = [i for i in sorted(theirs_match) if i in ours_match]
    merged: list[str] = []
    pb = pt = po = 0
    for anchor in (*anchors, None):
        if anchor is None:
            nb, nt, no = len(b_lines), len(t_lines), len(o_lines)
        else:
            nb, nt, no = anchor, theirs_match[anchor], ours_match[anchor]
        b_region, t_region, o_region = b_lines[pb:nb], t_lines[pt:nt], o_lines[po:no]
        if t_region == o_region or o_region == b_region:
            merged.extend(t_region)
        elif t_region == b_region:
            merged.extend(o_region)
        else:
            return MergeResult(None, OVERLAP)
        if anchor is not None:
            merged.append(b_lines[anchor])
            pb, pt, po = anchor + 1, theirs_match[anchor] + 1, ours_match[anchor] + 1

    final = t_final if t_final == o_final or o_final == b_final else o_final
    text = "".join(merged)
    if not final and text.endswith("\n"):
        text = text[:-1]
    if len(text.encode("utf-8")) > MAX_NOTE_BYTES:
        return MergeResult(None, TOO_LARGE)
    if _front_matter(text) not in (_front_matter(theirs), _front_matter(ours)):
        return MergeResult(None, FRONT_MATTER)
    return MergeResult(text)
