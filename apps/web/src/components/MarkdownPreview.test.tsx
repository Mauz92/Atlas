import { fireEvent, render, screen } from "@testing-library/react";

import { MarkdownPreview } from "./MarkdownPreview";

describe("MarkdownPreview", () => {
  it("renders headings, lists and code", () => {
    render(<MarkdownPreview content={"# Title\n\n- one\n- two\n\n```\ncode\n```\n"} />);
    expect(screen.getByRole("heading", { name: "Title" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("code")).toBeInTheDocument();
  });

  it("strips scripts from untrusted note content", () => {
    const { container } = render(
      <MarkdownPreview content={'<script>window.pwned = true</script>\n\nHello\n'} />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.innerHTML).not.toContain("pwned");
  });

  it("removes event handlers and javascript: links", () => {
    const { container } = render(
      <MarkdownPreview
        content={'<img src="x" onerror="window.pwned = true">\n\n[click](javascript:alert(1))\n'}
      />,
    );
    const image = container.querySelector("img");
    expect(image?.getAttribute("onerror")).toBeNull();
    expect(container.innerHTML).not.toContain("javascript:");
  });

  it("names each task-list checkbox after its item (axe `label`)", () => {
    render(<MarkdownPreview content={"- [ ] Buy bulbs\n- [x] Dig beds\n"} />);
    expect(screen.getByRole("checkbox", { name: "Buy bulbs" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Dig beds" })).toBeChecked();
  });

  it("keeps sanitising when it post-processes the checkboxes", () => {
    const { container } = render(
      <MarkdownPreview content={'- [ ] <img src="x" onerror="window.pwned = true">\n'} />,
    );
    expect(container.querySelector("img")?.getAttribute("onerror")).toBeNull();
    expect(container.innerHTML).not.toContain("pwned");
  });

  describe("[[links]]", () => {
    const notes = [
      { id: "n2", path: "Projects/Seed list.md" },
      { id: "n3", path: "Index.md" },
    ];

    it("render as links to the note, with an alias as the label", () => {
      render(<MarkdownPreview content={"See [[Projects/Seed list]] and [[index|the index]]."} notes={notes} />);
      expect(screen.getByRole("link", { name: "Projects/Seed list" })).toHaveAttribute("href", "/notes?open=n2");
      expect(screen.getByRole("link", { name: "the index" })).toHaveAttribute("href", "/notes?open=n3");
    });

    it("opens the note in the app instead of reloading the page", () => {
      const onOpenNote = vi.fn();
      render(<MarkdownPreview content="[[Index]]" notes={notes} onOpenNote={onOpenNote} />);
      fireEvent.click(screen.getByRole("link", { name: "Index" }));
      expect(onOpenNote).toHaveBeenCalledWith("n3");
    });

    it("shows an unresolved target as text, escapes it, and leaves code alone", () => {
      const { container } = render(
        <MarkdownPreview content={"[[Missing <b>x</b>]] and `[[Index]]`"} notes={notes} />,
      );
      expect(screen.queryByRole("link")).toBeNull();
      expect(container.querySelector(".wikilink.unresolved")?.textContent).toBe("Missing <b>x</b>");
      expect(container.querySelector("b")).toBeNull();
      expect(container.querySelector("code")?.textContent).toBe("[[Index]]");
    });
  });
});
