import os
from pathlib import Path

import pytest

from atlas.notes import NotesStorage, UnsafePathError, normalize_note_path, normalize_rel_path


def test_normalize_accepts_ordinary_paths() -> None:
    assert normalize_rel_path("Inbox/Note.md") == "Inbox/Note.md"
    assert normalize_rel_path("./Inbox//Note.md") == "Inbox/Note.md"
    assert normalize_rel_path("Inbox\\Note.md") == "Inbox/Note.md"
    assert normalize_rel_path("  spaced/name.md  ") == "spaced/name.md"
    assert normalize_rel_path("") == ""


@pytest.mark.parametrize(
    "bad",
    ["/etc/passwd", "..", "../outside.md", "Inbox/../../outside.md", "a/./../../b.md"],
)
def test_normalize_rejects_escapes(bad: str) -> None:
    with pytest.raises(UnsafePathError):
        normalize_rel_path(bad)


def test_note_path_gets_markdown_suffix() -> None:
    assert normalize_note_path("Inbox/Note") == "Inbox/Note.md"
    assert normalize_note_path("Inbox/Note.md") == "Inbox/Note.md"


def test_note_path_requires_a_value() -> None:
    with pytest.raises(UnsafePathError):
        normalize_note_path("")


def test_absolute_resolves_inside_root(tmp_path: Path) -> None:
    storage = NotesStorage(tmp_path)
    assert storage.absolute("Inbox/Note.md") == storage.root / "Inbox/Note.md"


def test_absolute_rejects_traversal(tmp_path: Path) -> None:
    storage = NotesStorage(tmp_path)
    with pytest.raises(UnsafePathError):
        storage.absolute("../outside.md")


def test_reserved_directory_is_rejected(tmp_path: Path) -> None:
    storage = NotesStorage(tmp_path)
    with pytest.raises(UnsafePathError):
        storage.absolute(".atlas/trash/x.md")


def test_symlink_escaping_the_root_is_rejected(tmp_path: Path) -> None:
    root = tmp_path / "notes"
    root.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.md").write_text("classified", encoding="utf-8")
    (root / "link").symlink_to(outside, target_is_directory=True)

    storage = NotesStorage(root)
    with pytest.raises(UnsafePathError):
        storage.absolute("link/secret.md")


def test_symlink_inside_the_root_is_allowed(tmp_path: Path) -> None:
    root = tmp_path / "notes"
    (root / "real").mkdir(parents=True)
    (root / "real" / "note.md").write_text("ok", encoding="utf-8")
    os.symlink(root / "real", root / "alias")

    storage = NotesStorage(root)
    assert storage.read("alias/note.md").content == "ok"
