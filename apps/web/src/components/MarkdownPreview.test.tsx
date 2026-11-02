import { render, screen } from "@testing-library/react";

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
});
