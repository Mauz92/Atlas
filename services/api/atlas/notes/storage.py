"""Markdown storage: safe paths, atomic writes and filesystem operations.

Everything the application does to note files goes through here. The invariants enforced:

* no path may escape the configured notes root (traversal, absolute paths, symlinks);
* writes are atomic (temp file + fsync + ``os.replace``);
* deletions are recoverable (files move to a trash area inside the root, never ``rm``);
* the root itself is the only place Atlas reads or writes note files.
"""

from __future__ import annotations

import hashlib
import os
import tempfile
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath

NOTE_SUFFIX = ".md"
MAX_NOTE_BYTES = 5 * 1024 * 1024
RESERVED_DIR = ".atlas"
_TRASH_DIR = "trash"
_TMP_PREFIX = ".atlas-tmp-"


class UnsafePathError(ValueError):
    """Raised when a requested path would escape the notes root or is reserved."""


class NoteTooLargeError(ValueError):
    """Raised when a note exceeds the maximum supported size."""


@dataclass(frozen=True)
class NoteFile:
    path: str
    content: str
    content_hash: str
    size_bytes: int
    modified_at: float


def content_hash(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def normalize_rel_path(rel: str) -> str:
    """Normalise a user-supplied relative path, rejecting anything unsafe."""
    if not isinstance(rel, str):
        raise UnsafePathError("path must be a string")
    candidate = rel.strip().replace("\\", "/")
    if candidate.startswith("/"):
        raise UnsafePathError("absolute paths are not allowed")
    parts = [part for part in PurePosixPath(candidate).parts if part not in ("", ".")]
    if any(part == ".." for part in parts):
        raise UnsafePathError("path traversal is not allowed")
    return "/".join(parts)


def normalize_note_path(rel: str) -> str:
    normalized = normalize_rel_path(rel)
    if not normalized:
        raise UnsafePathError("a note path is required")
    if not normalized.endswith(NOTE_SUFFIX):
        normalized = normalized + NOTE_SUFFIX
    return normalized


class NotesStorage:
    """Filesystem operations confined to a single notes root."""

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root).expanduser().resolve()

    # --- path handling -------------------------------------------------

    def ensure_root(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)

    def absolute(self, rel: str, *, allow_reserved: bool = False) -> Path:
        normalized = normalize_rel_path(rel)
        if not allow_reserved and RESERVED_DIR in PurePosixPath(normalized).parts:
            msg = f"{RESERVED_DIR} is reserved for Atlas"
            raise UnsafePathError(msg)
        target = self.root / normalized if normalized else self.root
        # ``resolve`` follows existing symlinks, so a link pointing outside the root is caught.
        resolved = target.resolve()
        if resolved != self.root and self.root not in resolved.parents:
            raise UnsafePathError("path escapes the notes root")
        return resolved

    def relative(self, path: Path) -> str:
        return path.relative_to(self.root).as_posix()

    # --- reads ---------------------------------------------------------

    def read(self, rel: str) -> NoteFile:
        normalized = normalize_note_path(rel)
        path = self.absolute(normalized)
        if not path.is_file():
            raise FileNotFoundError(normalized)
        size = path.stat().st_size
        if size > MAX_NOTE_BYTES:
            raise NoteTooLargeError(f"{normalized} exceeds {MAX_NOTE_BYTES} bytes")
        content = path.read_text(encoding="utf-8")
        return NoteFile(
            path=normalized,
            content=content,
            content_hash=content_hash(content),
            size_bytes=size,
            modified_at=path.stat().st_mtime,
        )

    def exists(self, rel: str) -> bool:
        try:
            return self.absolute(normalize_note_path(rel)).is_file()
        except UnsafePathError:
            return False

    # --- writes --------------------------------------------------------

    def write(self, rel: str, content: str) -> NoteFile:
        normalized = normalize_note_path(rel)
        path = self.absolute(normalized)
        encoded = content.encode("utf-8")
        if len(encoded) > MAX_NOTE_BYTES:
            raise NoteTooLargeError(f"{normalized} exceeds {MAX_NOTE_BYTES} bytes")
        self._atomic_write(path, content)
        return NoteFile(
            path=normalized,
            content=content,
            content_hash=content_hash(content),
            size_bytes=len(encoded),
            modified_at=path.stat().st_mtime,
        )

    def write_new(self, rel: str, content: str) -> NoteFile:
        """Create a note that must not exist yet; an existing file is never replaced.

        The content is written to a temporary file and published with a hard link, which fails
        with ``FileExistsError`` if the target appeared in the meantime, so two concurrent
        creators cannot overwrite each other and a reader never sees a half-written note.
        """
        normalized = normalize_note_path(rel)
        path = self.absolute(normalized)
        encoded = content.encode("utf-8")
        if len(encoded) > MAX_NOTE_BYTES:
            raise NoteTooLargeError(f"{normalized} exceeds {MAX_NOTE_BYTES} bytes")
        self._atomic_write(path, content, exclusive=True)
        return NoteFile(
            path=normalized,
            content=content,
            content_hash=content_hash(content),
            size_bytes=len(encoded),
            modified_at=path.stat().st_mtime,
        )

    def _atomic_write(self, path: Path, content: str, *, exclusive: bool = False) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_name = tempfile.mkstemp(dir=path.parent, prefix=_TMP_PREFIX, suffix=NOTE_SUFFIX)
        tmp_path = Path(tmp_name)
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="") as handle:
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
            if exclusive:
                os.link(tmp_path, path)
                tmp_path.unlink(missing_ok=True)
            else:
                os.replace(tmp_path, path)
            self._fsync_dir(path.parent)
        except BaseException:
            tmp_path.unlink(missing_ok=True)
            raise

    @staticmethod
    def _fsync_dir(directory: Path) -> None:
        try:
            dir_fd = os.open(directory, os.O_RDONLY)
        except OSError:  # pragma: no cover - platform dependent
            return
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)

    # --- moves and deletes ---------------------------------------------

    def move(self, src_rel: str, dst_rel: str) -> None:
        src = self.absolute(normalize_note_path(src_rel))
        dst = self.absolute(normalize_note_path(dst_rel))
        if not src.is_file():
            raise FileNotFoundError(src_rel)
        if dst.exists():
            raise FileExistsError(dst_rel)
        dst.parent.mkdir(parents=True, exist_ok=True)
        os.replace(src, dst)

    def delete(self, rel: str) -> str:
        """Move a note to the trash area. Returns the trashed path (relative)."""
        normalized = normalize_note_path(rel)
        src = self.absolute(normalized)
        if not src.is_file():
            raise FileNotFoundError(normalized)
        stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S%f")
        trash_dir = self.root / RESERVED_DIR / _TRASH_DIR / stamp
        trash_dir.mkdir(parents=True, exist_ok=True)
        destination = trash_dir / PurePosixPath(normalized).name
        os.replace(src, destination)
        return self.relative(destination)

    # --- folders --------------------------------------------------------

    def create_folder(self, rel: str) -> None:
        path = self.absolute(rel)
        if path.exists():
            raise FileExistsError(rel)
        path.mkdir(parents=True)

    def folder_is_empty(self, rel: str) -> bool:
        path = self.absolute(rel)
        if not path.is_dir():
            return True
        return not any(path.iterdir())

    def delete_folder(self, rel: str) -> None:
        path = self.absolute(rel)
        if not path.is_dir():
            raise FileNotFoundError(rel)
        if any(path.iterdir()):
            msg = "folder is not empty"
            raise OSError(msg)
        path.rmdir()

    def move_folder(self, src_rel: str, dst_rel: str) -> list[tuple[str, str]]:
        """Move a folder. Returns the ``(old, new)`` paths of the notes inside it."""
        src = self.absolute(src_rel)
        dst = self.absolute(dst_rel)
        if not src.is_dir():
            raise FileNotFoundError(src_rel)
        if dst.exists():
            raise FileExistsError(dst_rel)
        moves: list[tuple[str, str]] = []
        for current, _dirs, files in os.walk(src):
            current_path = Path(current)
            for name in files:
                if not name.endswith(NOTE_SUFFIX):
                    continue
                old_path = current_path / name
                new_path = dst / old_path.relative_to(src)
                moves.append((self.relative(old_path), self.relative(new_path)))
        dst.parent.mkdir(parents=True, exist_ok=True)
        src.rename(dst)
        return moves

    # --- listing --------------------------------------------------------

    def _walk(self) -> list[Path]:
        if not self.root.is_dir():
            return []
        found: list[Path] = []
        for current, dirs, files in os.walk(self.root):
            dirs[:] = sorted(d for d in dirs if d != RESERVED_DIR)
            for name in sorted(files):
                if name.endswith(NOTE_SUFFIX) and not name.startswith(_TMP_PREFIX):
                    found.append(Path(current) / name)
        return found

    def list_notes(self) -> list[str]:
        return sorted(self.relative(path) for path in self._walk())

    def list_folders(self) -> list[str]:
        if not self.root.is_dir():
            return []
        folders: list[str] = []
        for current, dirs, _files in os.walk(self.root):
            dirs[:] = sorted(d for d in dirs if d != RESERVED_DIR)
            current_path = Path(current)
            for name in dirs:
                folders.append(self.relative(current_path / name))
        return sorted(folders)
