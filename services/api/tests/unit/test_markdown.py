from atlas.notes.markdown import (
    extract_links,
    extract_tags,
    extract_title,
    normalize_link_target,
    parse,
    split_frontmatter,
)


def test_title_prefers_frontmatter_then_h1_then_filename() -> None:
    assert extract_title("---\ntitle: Declared\n---\n# Heading\n", "a.md") == "Declared"
    assert extract_title("# Heading\n\nbody\n", "a.md") == "Heading"
    assert extract_title("no heading here\n", "Folder/Name.md") == "Name"


def test_title_ignores_headings_inside_code() -> None:
    assert extract_title("```\n# not a title\n```\n", "Real.md") == "Real"


def test_frontmatter_split() -> None:
    frontmatter, body = split_frontmatter("---\ntags: [a]\n---\n# T\n")
    assert "tags: [a]" in frontmatter
    assert body.strip() == "# T"
    assert split_frontmatter("# T\n") == ("", "# T\n")


def test_tags_from_frontmatter_and_body() -> None:
    content = "---\ntags: [alpha, beta]\n---\n\nText with #gamma and #delta/nested.\n"
    assert extract_tags(content) == ["alpha", "beta", "delta/nested", "gamma"]


def test_block_style_frontmatter_tags() -> None:
    content = "---\ntags:\n  - one\n  - two\n---\nbody\n"
    assert extract_tags(content) == ["one", "two"]


def test_tags_ignore_headings_and_code() -> None:
    content = "# Heading\n\n```\n#notatag\n```\n\nInline `#also-not` and #real.\n"
    assert extract_tags(content) == ["real"]


def test_link_normalisation() -> None:
    assert normalize_link_target("Projects/Overview") == "Projects/Overview.md"
    assert normalize_link_target("Note.md") == "Note.md"
    assert normalize_link_target("Note|Alias") == "Note.md"
    assert normalize_link_target("Note#Section") == "Note.md"
    assert normalize_link_target("./Note") == "Note.md"


def test_links_are_extracted_deduplicated_and_ignore_code() -> None:
    content = "See [[Alpha]], [[Alpha|again]] and [[Folder/Beta]].\n\n```\n[[Ignored]]\n```\n"
    assert extract_links(content) == ["Alpha.md", "Folder/Beta.md"]


def test_parse_combines_everything() -> None:
    parsed = parse("# Title\n\n#tag\n\n[[Other]]\n", "Notes/Thing.md")
    assert parsed.title == "Title"
    assert parsed.tags == ["tag"]
    assert parsed.links == ["Other.md"]
