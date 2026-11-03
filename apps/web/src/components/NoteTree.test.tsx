import { fireEvent, render, screen, within } from "@testing-library/react";

import type { NoteSummary } from "../api/client";
import { buildTree } from "../lib/noteTree";
import { choose } from "../test/menu";
import { NoteTree, type NoteTreeActions, type TreeCreation, type TreeTarget } from "./NoteTree";

const NOTES: NoteSummary[] = [
  { id: "1", path: "A.md", title: "A", revision: 1, content_hash: "h", size_bytes: 1 },
  { id: "2", path: "Folder/B.md", title: "B", revision: 1, content_hash: "h", size_bytes: 1 },
  { id: "3", path: "Folder/Deep/C.md", title: "C", revision: 1, content_hash: "h", size_bytes: 1 },
];

function actions(): NoteTreeActions {
  return { rename: vi.fn(), move: vi.fn(), remove: vi.fn(), newIn: vi.fn(), newFromTemplate: vi.fn() };
}

function renderTree(
  overrides: {
    collapsed?: Set<string>;
    creation?: TreeCreation | null;
    renaming?: TreeTarget | null;
    templates?: { id: string; name: string }[];
  } = {},
) {
  const handlers = {
    onSelect: vi.fn(),
    onToggleFolder: vi.fn(),
    onCreate: vi.fn(),
    onCancelCreate: vi.fn(),
    onRename: vi.fn(),
    onCancelRename: vi.fn(),
    actions: actions(),
  };
  render(
    <main>
      <NoteTree
        tree={buildTree(["Folder", "Folder/Deep"], NOTES)}
        selectedId="2"
        collapsed={overrides.collapsed ?? new Set()}
        folderPaths={["Folder", "Folder/Deep"]}
        templates={overrides.templates ?? []}
        creation={overrides.creation ?? null}
        renaming={overrides.renaming ?? null}
        {...handlers}
      />
    </main>,
  );
  return handlers;
}

describe("NoteTree", () => {
  it("nests notes under their folders and marks the open note", () => {
    renderTree();
    expect(screen.getByRole("button", { name: "Folder" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Deep" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "A" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "C" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "B" })).toHaveAttribute("aria-current", "true");
  });

  it("reports the selected note id and toggles a folder", () => {
    const { onSelect, onToggleFolder } = renderTree();
    fireEvent.click(screen.getByRole("button", { name: "B" }));
    expect(onSelect).toHaveBeenCalledWith("2");
    fireEvent.click(screen.getByRole("button", { name: "Deep" }));
    expect(onToggleFolder).toHaveBeenCalledWith("Folder/Deep");
  });

  it("hides the contents of a collapsed folder but opens one that is being added to", () => {
    renderTree({ collapsed: new Set(["Folder"]) });
    expect(screen.queryByRole("button", { name: "B" })).toBeNull();
    expect(screen.getByRole("button", { name: "Folder" })).toHaveAttribute("aria-expanded", "false");
  });

  it("offers Rename, Move to… and Delete on a note row and moves to another folder", () => {
    const { actions: calls } = renderTree();
    fireEvent.click(screen.getByRole("button", { name: "Actions for B" }));
    const menu = screen.getByRole("menu", { name: "Actions for B" });
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Rename",
      "Move to…",
      "New from templateNo templates",
      "Delete",
    ]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to…" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Folder/Deep" }));
    expect(calls.move).toHaveBeenCalledWith("2", "Folder/Deep");
  });

  it("starts an inline rename and deletes from the menu", async () => {
    const { actions: calls } = renderTree();
    await choose("Actions for A", "Rename");
    expect(calls.rename).toHaveBeenCalledWith({ kind: "note", id: "1", path: "A.md", title: "A" });
    await choose("Actions for A", "Delete");
    expect(calls.remove).toHaveBeenCalledWith(expect.objectContaining({ kind: "note", id: "1" }));
  });

  it("folder rows create inside the folder and list templates", async () => {
    const { actions: calls } = renderTree({ templates: [{ id: "t1", name: "Meeting" }] });
    await choose("Actions for folder Folder", "New note here");
    expect(calls.newIn).toHaveBeenCalledWith("note", "Folder");
    await choose("Actions for folder Folder", "New from template", "Meeting");
    expect(calls.newFromTemplate).toHaveBeenCalledWith("t1", "Folder");
  });

  it("commits an inline name with Enter and cancels with Escape or blur", () => {
    const handlers = renderTree({ creation: { folder: "Folder", label: "New note name" } });
    const input = screen.getByRole("textbox", { name: "New note name" });
    fireEvent.change(input, { target: { value: "Idea" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(handlers.onCreate).toHaveBeenCalledWith("Idea");
    expect(handlers.onCancelCreate).not.toHaveBeenCalled();
  });

  it("cancels an inline name with Escape, and an unchanged rename counts as a cancel", () => {
    const handlers = renderTree({
      renaming: { kind: "note", id: "1", path: "A.md", title: "A" },
    });
    const input = screen.getByRole("textbox", { name: "Rename A" });
    expect(input).toHaveValue("A");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(handlers.onRename).not.toHaveBeenCalled();
    expect(handlers.onCancelRename).toHaveBeenCalled();
  });
});
