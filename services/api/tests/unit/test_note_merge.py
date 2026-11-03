"""Three-way note merge (SYNC-04): examples, byte exactness and seeded property tests.

The property tests are deterministic (a fixed range of seeds) and need no extra dependency. Each
failure message names the seed so it can be replayed with ``-k <seed>``.
"""

from __future__ import annotations

import random

import pytest

from atlas.notes.merge import FRONT_MATTER, MAX_LINES, OVERLAP, TOO_LARGE, merge3

# --- examples --------------------------------------------------------------------------------


def test_edits_in_different_paragraphs_merge() -> None:
    base = "# T\n\nfirst\n\nsecond\n\nthird\n"
    theirs = base.replace("first", "FIRST")
    ours = base.replace("third", "THIRD")
    assert merge3(base, theirs, ours).text == "# T\n\nFIRST\n\nsecond\n\nTHIRD\n"


def test_the_same_edit_on_both_sides_is_one_edit() -> None:
    base = "a\nb\nc\n"
    both = "a\nB\nc\n"
    assert merge3(base, both, both).text == both


def test_overlapping_edits_do_not_merge() -> None:
    result = merge3("a\nb\nc\n", "a\nB1\nc\n", "a\nB2\nc\n")
    assert result.text is None and result.reason == OVERLAP


def test_touching_edits_do_not_merge() -> None:
    """Adjacent changes are one region in diff3: uncertain, so a conflict (never a guess)."""
    result = merge3("a\nb\nc\nd\n", "A\nb\nc\nd\n", "a\nB\nc\nd\n")
    assert result.text is None and result.reason == OVERLAP


def test_two_insertions_at_the_same_place_conflict() -> None:
    assert merge3("a\nb\n", "a\nX\nb\n", "a\nY\nb\n").text is None


def test_a_deletion_and_an_edit_elsewhere_merge() -> None:
    base = "a\nb\nc\nd\ne\n"
    assert merge3(base, "a\nc\nd\ne\n", "a\nb\nc\nd\nE\n").text == "a\nc\nd\nE\n"


def test_a_delete_against_an_edit_of_the_same_line_conflicts() -> None:
    assert merge3("a\nb\nc\n", "a\nc\n", "a\nBB\nc\n").text is None


def test_crlf_is_kept_on_every_line() -> None:
    base = "one\r\ntwo\r\nthree\r\nfour\r\nfive\r\n"
    theirs = base.replace("one", "ONE")
    ours = base.replace("five", "FIVE")
    merged = merge3(base, theirs, ours).text
    assert merged == "ONE\r\ntwo\r\nthree\r\nfour\r\nFIVE\r\n"
    assert merged is not None and "\n" not in merged.replace("\r\n", "")


def test_mixed_line_endings_survive() -> None:
    base = "a\r\nb\nc\r\nd\ne\r\n"
    merged = merge3(base, base.replace("a", "A"), base.replace("e", "E")).text
    assert merged == "A\r\nb\nc\r\nd\nE\r\n"


def test_converting_every_line_ending_conflicts_with_a_content_edit() -> None:
    base = "a\nb\nc\n"
    crlf = "a\r\nb\r\nc\r\n"
    assert merge3(base, crlf, "a\nb\nC\n").text is None
    assert merge3(base, crlf, base).text == crlf, "a pure line-ending change is simply taken"


def test_appending_to_a_note_without_a_trailing_newline_merges_with_an_edit_above() -> None:
    base = "a\nb"
    theirs = "a\nb\n- new"  # appended on one device
    ours = "A\nb"  # edited above on another
    assert merge3(base, theirs, ours).text == "A\nb\n- new"
    assert merge3(base, ours, theirs).text == "A\nb\n- new"


def test_the_final_newline_follows_the_side_that_changed_it() -> None:
    base = "a\nb\nc\n"
    assert merge3(base, "a\nb\nc", "A\nb\nc\n").text == "A\nb\nc"
    assert merge3(base, "A\nb\nc\n", "a\nb\nc").text == "A\nb\nc"


def test_empty_notes() -> None:
    assert merge3("", "x\n", "").text == "x\n"
    assert merge3("", "", "y").text == "y"
    assert merge3("a\n", "", "a\n").text == ""
    assert merge3("a\n", "", "").text == ""
    assert merge3("", "x\n", "y\n").text is None


def test_unicode_bom_and_emoji_pass_through_untouched() -> None:
    base = "﻿Title ünï\n\nline 😀\n\nlast 日本語\n"
    theirs = base.replace("Title", "Titel")
    ours = base.replace("last", "final")
    assert merge3(base, theirs, ours).text == "﻿Titel ünï\n\nline 😀\n\nfinal 日本語\n"


def test_a_lone_carriage_return_is_part_of_its_line() -> None:
    base = "a\rb\nc\nd\ne\n"
    merged = merge3(base, base.replace("c", "C"), base.replace("e", "E")).text
    assert merged == "a\rb\nC\nd\nE\n"


# --- front matter --------------------------------------------------------------------------


def test_a_front_matter_edit_on_one_side_merges_with_a_body_edit() -> None:
    base = "---\ntitle: A\ntags: [x]\n---\nbody 1\n\nbody 2\n\nbody 3\n"
    theirs = base.replace("title: A", "title: B")
    ours = base.replace("body 3", "BODY 3")
    assert merge3(base, theirs, ours).text == (
        "---\ntitle: B\ntags: [x]\n---\nbody 1\n\nbody 2\n\nBODY 3\n"
    )


def test_front_matter_assembled_from_both_sides_is_a_conflict() -> None:
    """Two different keys edited on the two sides would merge textually, but the block would match
    neither side: the result is never checked as YAML here, so it is refused."""
    base = "---\ntitle: A\nstatus: draft\naliases: [q]\ntags: [x]\n---\nbody\n"
    theirs = base.replace("title: A", "title: B")
    ours = base.replace("tags: [x]", "tags: [y]")
    result = merge3(base, theirs, ours)
    assert result.text is None and result.reason == FRONT_MATTER


def test_crlf_front_matter_is_recognised() -> None:
    base = "---\r\na: 1\r\nb: 2\r\nc: 3\r\n---\r\nx\r\n"
    result = merge3(base, base.replace("a: 1", "a: 9"), base.replace("c: 3", "c: 9"))
    assert result.reason == FRONT_MATTER


# --- limits ----------------------------------------------------------------------------------


def test_a_huge_note_is_not_merged() -> None:
    base = "x\n" * (MAX_LINES + 1)
    result = merge3(base, "y\n" + base, base + "z\n")
    assert result.text is None and result.reason == TOO_LARGE


def test_a_pathological_diff_is_refused_rather_than_stalling() -> None:
    base = "\n".join(f"l{i}" for i in range(0, 6000)) + "\n"
    theirs = "\n".join(f"t{i}" for i in range(0, 6000)) + "\n"
    ours = "\n".join(f"o{i}" for i in range(0, 6000)) + "\n"
    assert merge3(base, theirs, ours).reason == TOO_LARGE


# --- properties (seeded) ---------------------------------------------------------------------

SEEDS = range(300)


def _eol(rng: random.Random) -> str:
    return rng.choice(["\n", "\n", "\r\n"])


def _random_text(rng: random.Random) -> tuple[list[str], bool]:
    """Unique-ish lines (with a few duplicates and blanks) and a final-newline flag."""
    pool = ["", "", "- item", "## heading", "text ünï", "😀"]
    lines = []
    for index in range(rng.randint(0, 30)):
        body = rng.choice(pool) if rng.random() < 0.25 else f"line {index} {rng.randint(0, 99)}"
        lines.append(body + _eol(rng))
    final = rng.random() < 0.7
    return lines, final


def _join(lines: list[str], final: bool) -> str:
    text = "".join(lines)
    if not final and text.endswith("\n"):
        text = text[:-1]
    return text


@pytest.mark.parametrize("seed", SEEDS)
def test_merge_identities(seed: int) -> None:
    """merge(base, a, a) = a; merge(base, base, x) = x; merge(base, x, base) = x."""
    rng = random.Random(seed)
    base_lines, base_final = _random_text(rng)
    base = _join(base_lines, base_final)
    other_lines, other_final = _random_text(rng)
    other = _join(other_lines, other_final)
    assert merge3(base, other, other).text == other, f"seed={seed}"
    assert merge3(base, base, other).text == other, f"seed={seed}"
    assert merge3(base, other, base).text == other, f"seed={seed}"
    assert merge3(base, base, base).text == base, f"seed={seed}"


def _apply_edits(
    rng: random.Random, base_lines: list[str]
) -> tuple[list[str], list[str], list[str]]:
    """Disjoint edit blocks separated by at least one untouched line, each given to one side.

    Returns ``(theirs, ours, expected)`` where ``expected`` has every edit applied.
    """
    theirs: list[str] = []
    ours: list[str] = []
    expected: list[str] = []
    index = serial = 0

    def keep(line: str) -> None:
        for target in (theirs, ours, expected):
            target.append(line)

    while index < len(base_lines):
        side = rng.choice("TO")
        span = rng.randint(0, min(3, len(base_lines) - index))
        replacement = [f"new {side}{serial}.{k}" + _eol(rng) for k in range(rng.randint(0, 2))]
        serial += 1
        if rng.random() >= 0.3 or (span == 0 and not replacement):
            keep(base_lines[index])
            index += 1
            continue
        original = base_lines[index : index + span]
        theirs.extend(replacement if side == "T" else original)
        ours.extend(replacement if side == "O" else original)
        expected.extend(replacement)
        index += span
        if index < len(base_lines):  # the separating anchor line
            keep(base_lines[index])
            index += 1
    return theirs, ours, expected


def _unique_text(rng: random.Random) -> tuple[list[str], bool]:
    lines = [f"line {i} {rng.randint(0, 99)}" + _eol(rng) for i in range(rng.randint(0, 30))]
    return lines, rng.random() < 0.7


@pytest.mark.parametrize("seed", SEEDS)
def test_disjoint_edits_merge_to_the_union_and_are_symmetric_and_idempotent(seed: int) -> None:
    rng = random.Random(seed)
    base_lines, final = _unique_text(rng)
    if not base_lines:
        pytest.skip("nothing to edit")
    t_lines, o_lines, expected_lines = _apply_edits(rng, base_lines)
    base, theirs, ours = _join(base_lines, final), _join(t_lines, final), _join(o_lines, final)
    expected = _join(expected_lines, final)
    forward = merge3(base, theirs, ours)
    backward = merge3(base, ours, theirs)
    assert forward.text == expected, f"seed={seed}: {forward}"
    assert backward.text == expected, f"seed={seed} (swapped): {backward}"
    # re-applying either side to the result changes nothing
    assert merge3(base, expected, ours).text == expected, f"seed={seed}: not idempotent (ours)"
    assert merge3(base, theirs, expected).text == expected, f"seed={seed}: not idempotent (theirs)"


@pytest.mark.parametrize("seed", SEEDS)
def test_with_repeated_lines_a_merge_is_either_right_or_refused(seed: int) -> None:
    """Duplicate lines (blank lines, repeated bullets) make the alignment ambiguous: the merge
    may refuse, but a clean answer must still be exactly the union of the edits."""
    rng = random.Random(seed)
    base_lines, final = _random_text(rng)
    if not base_lines:
        pytest.skip("nothing to edit")
    t_lines, o_lines, expected_lines = _apply_edits(rng, base_lines)
    base, theirs, ours = _join(base_lines, final), _join(t_lines, final), _join(o_lines, final)
    expected = _join(expected_lines, final)
    for result in (merge3(base, theirs, ours), merge3(base, ours, theirs)):
        assert result.text in (None, expected), f"seed={seed}: wrong merge {result}"


@pytest.mark.parametrize("seed", SEEDS)
def test_two_different_edits_of_the_same_lines_never_merge(seed: int) -> None:
    rng = random.Random(seed)
    base_lines = [f"line {i}\n" for i in range(rng.randint(3, 20))]
    start = rng.randint(0, len(base_lines) - 2)
    span = rng.randint(1, min(3, len(base_lines) - start))
    t_lines = [*base_lines[:start], "theirs\n", *base_lines[start + span :]]
    o_lines = [*base_lines[:start], "ours\n", *base_lines[start + span :]]
    result = merge3("".join(base_lines), "".join(t_lines), "".join(o_lines))
    assert result.text is None, f"seed={seed}: merged {result.text!r}"


@pytest.mark.parametrize("seed", SEEDS)
def test_a_clean_merge_loses_no_line_that_neither_side_removed(seed: int) -> None:
    """Whatever the edits, a clean result contains every line both sides kept, and every line a
    side added; random (mostly overlapping) edits exercise both outcomes."""
    rng = random.Random(seed)
    base_lines = [f"base {i}\n" for i in range(rng.randint(0, 25))]

    def edit(tag: str) -> list[str]:
        lines = list(base_lines)
        for k in range(rng.randint(0, 4)):
            op = rng.choice(["ins", "del", "rep"])
            at = rng.randint(0, len(lines))
            if op == "ins" or not lines:
                lines.insert(at, f"{tag}{k}\n")
            elif op == "del":
                del lines[min(at, len(lines) - 1)]
            else:
                lines[min(at, len(lines) - 1)] = f"{tag}{k}\n"
        return lines

    t_lines, o_lines = edit("T"), edit("O")
    result = merge3("".join(base_lines), "".join(t_lines), "".join(o_lines))
    if result.text is None:
        return
    merged = result.text.splitlines(keepends=True)
    kept_by_both = set(t_lines) & set(o_lines)
    added = {line for line in (*t_lines, *o_lines) if line not in base_lines}
    for line in kept_by_both | added:
        assert line in merged, f"seed={seed}: {line!r} lost from {merged}"
    for line in base_lines:
        if line not in t_lines and line not in o_lines:
            assert line not in merged or base_lines.count(line) > 1, (
                f"seed={seed}: resurrected {line!r}"
            )
