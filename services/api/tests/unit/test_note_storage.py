from pathlib import Path

import pytest

from atlas.notes import NotesStorage, content_hash
from atlas.notes.storage import RESERVED_DIR


@pytest.fixture
def storage(tmp_path: Path) -> NotesStorage:
    instance = NotesStorage(tmp_path / "notes")
    instance.ensure_root()
    return instance


def test_write_and_read_round_trip(storage: NotesStorage) -> None:
    written = storage.write("Inbox/First.md", "# Hello\n\nBody.\n")
    assert written.path == "Inbox/First.md"
    assert written.content_hash == content_hash("# Hello\n\nBody.\n")

    read = storage.read("Inbox/First")
    assert read.content == "# Hello\n\nBody.\n"
    assert read.content_hash == written.content_hash
    assert read.size_bytes == len(b"# Hello\n\nBody.\n")


def test_unicode_and_special_characters_survive(storage: NotesStorage) -> None:
    content = "# Ünïcödé 🎉\n\nÉmoji, 日本語, Кириллица, em—dash.\n"
    storage.write("Unicode.md", content)
    assert storage.read("Unicode.md").content == content
    assert (storage.root / "Unicode.md").read_text(encoding="utf-8") == content


def test_write_leaves_no_temporary_files(storage: NotesStorage) -> None:
    storage.write("Note.md", "x")
    storage.write("Note.md", "y")
    leftovers = [p.name for p in storage.root.iterdir() if p.name.startswith(".atlas-tmp-")]
    assert leftovers == []


def test_write_creates_missing_folders(storage: NotesStorage) -> None:
    storage.write("Deep/Nested/Note.md", "x")
    assert (storage.root / "Deep" / "Nested" / "Note.md").is_file()


def test_delete_moves_the_file_to_trash(storage: NotesStorage) -> None:
    storage.write("Doomed.md", "bye")
    trashed = storage.delete("Doomed.md")

    assert not (storage.root / "Doomed.md").exists()
    assert trashed.startswith(f"{RESERVED_DIR}/trash/")
    assert (storage.root / trashed).read_text(encoding="utf-8") == "bye"


def test_move(storage: NotesStorage) -> None:
    storage.write("Old.md", "content")
    storage.move("Old.md", "Folder/New.md")
    assert not (storage.root / "Old.md").exists()
    assert storage.read("Folder/New.md").content == "content"


def test_move_refuses_to_overwrite(storage: NotesStorage) -> None:
    storage.write("A.md", "a")
    storage.write("B.md", "b")
    with pytest.raises(FileExistsError):
        storage.move("A.md", "B.md")


def test_folder_lifecycle(storage: NotesStorage) -> None:
    storage.create_folder("Archive")
    assert storage.folder_is_empty("Archive")

    storage.write("Archive/Note.md", "x")
    assert not storage.folder_is_empty("Archive")
    with pytest.raises(OSError):
        storage.delete_folder("Archive")

    storage.delete("Archive/Note.md")
    storage.delete_folder("Archive")
    assert not (storage.root / "Archive").exists()


def test_move_folder_moves_notes_and_reports_the_mapping(storage: NotesStorage) -> None:
    storage.write("Old/One.md", "1")
    storage.write("Old/Sub/Two.md", "2")
    moves = dict(storage.move_folder("Old", "New"))

    assert moves == {"Old/One.md": "New/One.md", "Old/Sub/Two.md": "New/Sub/Two.md"}
    assert sorted(storage.list_notes()) == ["New/One.md", "New/Sub/Two.md"]


def test_listing_ignores_trash_and_temporary_files(storage: NotesStorage) -> None:
    storage.write("Keep.md", "x")
    storage.write("Gone.md", "y")
    storage.delete("Gone.md")
    (storage.root / ".atlas-tmp-orphan.md").write_text("junk", encoding="utf-8")

    assert storage.list_notes() == ["Keep.md"]


def test_list_folders(storage: NotesStorage) -> None:
    storage.write("A/B/Note.md", "x")
    assert storage.list_folders() == ["A", "A/B"]
