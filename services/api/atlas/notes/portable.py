"""Portable note paths (SYNC-04, ADR-0059 D10, ``SYNC_PROTOCOL.md`` section 11).

A note synced to a Windows or Android client lives in that client's file system, so a path the
server accepts must be usable there. In sync mode the server refuses (``422 invalid_path``) a path
that is invalid on Windows or too long, and treats a path that differs from another live note's
only by letter case or Unicode normalisation as *taken* (a create is renamed to ``name (2).md``, a
move is ``409 path_exists``): two such notes would overwrite each other on a case-insensitive
file system.

Outside sync mode nothing here applies: the web app and existing notes keep every path they have.
"""

from __future__ import annotations

import unicodedata

#: Characters Windows forbids in a file name (``/`` and ``\`` separate segments before this runs).
_FORBIDDEN = frozenset('<>:"|?*')
#: Device names Windows reserves, with or without an extension (``CON.md`` is ``CON``).
_RESERVED = frozenset(
    {"CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"}
    | {f"{prefix}{digit}" for prefix in ("COM", "LPT") for digit in "0123456789¹²³"}
)
#: The whole relative path, in characters (Windows MAX_PATH is 260 including the notes root).
MAX_PATH_CHARS = 240
#: One path segment, in UTF-8 bytes (ext4 and Android limit a name to 255 bytes).
MAX_SEGMENT_BYTES = 255


class PortablePathError(ValueError):
    """The path would be unusable on Windows or Android; ``reason`` is a stable code."""

    def __init__(self, reason: str, detail: str) -> None:
        super().__init__(detail)
        self.reason = reason
        self.detail = detail


def check_portable(path: str) -> None:
    """Raise :class:`PortablePathError` unless ``path`` (normalised, relative, ``/``-separated) is
    usable on every supported platform."""
    if len(path) > MAX_PATH_CHARS:
        raise PortablePathError("too_long", f"a path may have at most {MAX_PATH_CHARS} characters")
    for segment in path.split("/"):
        if len(segment.encode("utf-8")) > MAX_SEGMENT_BYTES:
            raise PortablePathError(
                "name_too_long", f"a file or folder name may have at most {MAX_SEGMENT_BYTES} bytes"
            )
        bad = sorted({ch for ch in segment if ch in _FORBIDDEN or ord(ch) < 32 or ord(ch) == 127})
        if bad:
            shown = "".join(ch if ch.isprintable() else f"\\x{ord(ch):02x}" for ch in bad)
            raise PortablePathError("forbidden_character", f"a name may not contain {shown}")
        if segment.endswith((".", " ")):
            raise PortablePathError(
                "trailing_dot_or_space", "a name may not end with a dot or a space"
            )
        if segment.split(".", 1)[0].rstrip(" ").upper() in _RESERVED:
            raise PortablePathError(
                "reserved_name", f"{segment.split('.', 1)[0]} is a reserved name on Windows"
            )


def fold(path: str) -> str:
    """The comparison key of a path on a case-insensitive file system with normalising names."""
    return unicodedata.normalize("NFC", path).casefold()
