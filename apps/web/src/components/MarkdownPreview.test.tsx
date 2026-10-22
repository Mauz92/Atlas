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
});
