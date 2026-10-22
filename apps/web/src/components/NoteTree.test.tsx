import { fireEvent, render, screen } from "@testing-library/react";

import type { NoteSummary } from "../api/client";
import { buildTree } from "../lib/noteTree";
import { NoteTree } from "./NoteTree";

const NOTES: NoteSummary[] = [
  { id: "1", path: "A.md", title: "A", revision: 1, content_hash: "h", size_bytes: 1 },
  { id: "2", path: "Folder/B.md", title: "B", revision: 1, content_hash: "h", size_bytes: 1 },
  { id: "3", path: "Folder/Deep/C.md", title: "C", revision: 1, content_hash: "h", size_bytes: 1 },
];

function renderTree(onSelect = vi.fn(), onSelectFolder = vi.fn()) {
  render(
    <NoteTree
      tree={buildTree(["Folder", "Folder/Deep"], NOTES)}
      selectedId={null}
      onSelect={onSelect}
      onSelectFolder={onSelectFolder}
    />,
  );
  return { onSelect, onSelectFolder };
}

describe("NoteTree", () => {
  it("nests notes under their folders", () => {
    renderTree();
    expect(screen.getByRole("button", { name: "Folder/" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deep/" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "A" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "C" })).toBeInTheDocument();
  });

  it("reports the selected note id", () => {
    const { onSelect } = renderTree();
    fireEvent.click(screen.getByRole("button", { name: "B" }));
    expect(onSelect).toHaveBeenCalledWith("2");
  });

  it("reports the selected folder path", () => {
    const { onSelectFolder } = renderTree();
    fireEvent.click(screen.getByRole("button", { name: "Deep/" }));
    expect(onSelectFolder).toHaveBeenCalledWith("Folder/Deep");
  });
});
