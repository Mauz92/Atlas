"""Markdown parsing: title, tags and wiki-style links.

Deliberately small: Atlas needs enough structure to build an index, not a full CommonMark
parser. Note content is always preserved verbatim on disk; nothing here rewrites a note.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import PurePosixPath

from .storage import NOTE_SUFFIX

_FRONTMATTER_RE = re.compile(r"\A---[ \t]*\n(.*?)\n---[ \t]*\n?", re.DOTALL)
_FENCED_CODE_RE = re.compile(r"```.*?```", re.DOTALL)
_INLINE_CODE_RE = re.compile(r"`[^`\n]*`")
_H1_RE = re.compile(r"^#[ \t]+(.+?)[ \t]*$", re.MULTILINE)
_WIKI_LINK_RE = re.compile(r"\[\[([^\[\]\n]+?)\]\]")
_TAG_RE = re.compile(r"(?:^|[\s(])#([A-Za-z0-9_][A-Za-z0-9_\-/]*)")


@dataclass
class ParsedNote:
    title: str
    tags: list[str] = field(default_factory=list)
    links: list[str] = field(default_factory=list)


def strip_code(content: str) -> str:
    """Remove fenced and inline code so tags/links inside code are not indexed."""
    return _INLINE_CODE_RE.sub(" ", _FENCED_CODE_RE.sub(" ", content))


def split_frontmatter(content: str) -> tuple[str, str]:
    """Return ``(frontmatter, body)``; frontmatter is empty when absent."""
    match = _FRONTMATTER_RE.match(content)
    if not match:
        return "", content
    return match.group(1), content[match.end() :]


def _frontmatter_scalar(frontmatter: str, key: str) -> str | None:
    for line in frontmatter.splitlines():
        stripped = line.strip()
        if stripped.startswith(f"{key}:"):
            return stripped[len(key) + 1 :].strip()
    return None


def _frontmatter_list(frontmatter: str, key: str) -> list[str]:
    """Minimal reader for a top-level YAML list, supporting inline and block forms."""
    lines = frontmatter.splitlines()
    collected: list[str] = []
    for index, line in enumerate(lines):
        if not line.strip().startswith(f"{key}:"):
            continue
        inline = line.split(":", 1)[1].strip()
        if inline.startswith("["):
            inline = inline.strip("[]")
            collected.extend(part.strip().strip("\"'") for part in inline.split(","))
        for follow in lines[index + 1 :]:
            if follow.startswith((" ", "\t")) and follow.strip().startswith("-"):
                collected.append(follow.strip()[1:].strip().strip("\"'"))
            elif follow.strip():
                break
        break
    return [item for item in collected if item]


def extract_title(content: str, fallback_path: str) -> str:
    frontmatter, body = split_frontmatter(content)
    if frontmatter:
        declared = _frontmatter_scalar(frontmatter, "title")
        if declared:
            return declared.strip("\"'")
    heading = _H1_RE.search(strip_code(body))
    if heading:
        return heading.group(1).strip()
    return PurePosixPath(fallback_path).stem


def extract_tags(content: str) -> list[str]:
    frontmatter, body = split_frontmatter(content)
    tags = {tag.lstrip("#") for tag in _frontmatter_list(frontmatter, "tags")}
    for match in _TAG_RE.finditer(strip_code(body)):
        tags.add(match.group(1))
    return sorted(tag for tag in tags if tag)


def normalize_link_target(raw: str) -> str:
    """Turn a wiki-link target into a note path relative to the notes root."""
    target = raw.split("|", 1)[0].strip()
    target = target.split("#", 1)[0].split("^", 1)[0].strip()
    target = target.lstrip("./").replace("\\", "/")
    if not target:
        return ""
    if not target.endswith(NOTE_SUFFIX):
        target += NOTE_SUFFIX
    return target


def extract_links(content: str) -> list[str]:
    _frontmatter, body = split_frontmatter(content)
    seen: list[str] = []
    for match in _WIKI_LINK_RE.finditer(strip_code(body)):
        target = normalize_link_target(match.group(1))
        if target and target not in seen:
            seen.append(target)
    return seen


def parse(content: str, path: str) -> ParsedNote:
    return ParsedNote(
        title=extract_title(content, path),
        tags=extract_tags(content),
        links=extract_links(content),
    )
