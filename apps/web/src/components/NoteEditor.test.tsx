import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { render } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { documentText } from "../lib/livePreview";
import { NoteEditor } from "./NoteEditor";

beforeAll(() => {
  Range.prototype.getClientRects ??= (() => []) as unknown as Range["getClientRects"];
  Range.prototype.getBoundingClientRect ??= (() =>
    ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 })) as unknown as Range["getBoundingClientRect"];
});

const NOTES = [{ id: "n1", path: "Target.md", title: "Target" }] as never;

function viewOf(container: HTMLElement): EditorView {
  const view = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement);
  if (!view) throw new Error("no editor");
  return view;
}

describe("NoteEditor modes (UX-06)", () => {
  it("Source shows the Markdown as typed; Live renders it; the text is the same in both", () => {
    const text = "# Title\n\nSome **bold** and [[Target]].\n\n- [ ] task\n";
    const onChange = vi.fn();
    const { container, rerender } = render(<NoteEditor value={text} onChange={onChange} notes={NOTES} mode="source" />);
    const content = container.querySelector(".cm-content") as HTMLElement;
    expect(content.textContent).toContain("# Title");
    expect(content.textContent).toContain("**bold**");
    expect(content.querySelector(".cm-live-h1")).toBeNull();

    rerender(<NoteEditor value={text} onChange={onChange} notes={NOTES} mode="live" />);
    expect(content.querySelector(".cm-live-h1")?.textContent).toBe("Title");
    expect(content.querySelector(".cm-live-strong")?.textContent).toBe("bold");
    expect(content.querySelector(".cm-live-wikilink")?.textContent).toBe("Target");
    expect(content.querySelector("input[type=checkbox]")).not.toBeNull();
    expect(content.getAttribute("aria-label")).toBe("Note content");
    expect(content.getAttribute("role")).toBe("textbox");

    rerender(<NoteEditor value={text} onChange={onChange} notes={NOTES} mode="source" />);
    expect(content.textContent).toContain("# Title");
    expect(documentText(viewOf(container).state)).toBe(text);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("switching mode keeps the document, the selection and the undo history", () => {
    const text = "alpha\nbeta\ngamma\n";
    const onChange = vi.fn();
    const { container, rerender } = render(<NoteEditor value={text} onChange={onChange} mode="source" />);
    const view = viewOf(container);
    view.dispatch({ selection: { anchor: 8, head: 12 } });
    view.dispatch({ changes: { from: 0, insert: "X" } });
    const before = view.state.selection.main;
    expect(onChange).toHaveBeenLastCalledWith("Xalpha\nbeta\ngamma\n");

    for (const mode of ["live", "source", "live"] as const) {
      rerender(<NoteEditor value={onChange.mock.lastCall![0]} onChange={onChange} mode={mode} />);
      expect(viewOf(container)).toBe(view);
      expect(view.state.selection.main.anchor).toBe(before.anchor);
      expect(view.state.selection.main.head).toBe(before.head);
      expect(documentText(view.state)).toBe("Xalpha\nbeta\ngamma\n");
    }
    // The typing made before the switches is still one undo step away.
    undo(view);
    expect(onChange).toHaveBeenLastCalledWith(text);
  });

  it("a ticked checkbox reaches onChange as ordinary text", () => {
    const onChange = vi.fn();
    const { container } = render(<NoteEditor value={"- [ ] one\n- [x] two\n"} onChange={onChange} mode="live" />);
    const box = container.querySelector<HTMLInputElement>("input.cm-live-checkbox")!;
    box.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("- [x] one\n- [x] two\n");
  });

  it("a wiki link click asks the page to open the note", () => {
    const onOpenNote = vi.fn();
    const { container } = render(
      <NoteEditor value={"See [[Target]].\n"} onChange={vi.fn()} notes={NOTES} mode="live" onOpenNote={onOpenNote} />,
    );
    container
      .querySelector(".cm-live-wikilink")!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    expect(onOpenNote).toHaveBeenCalledWith("n1");
  });

  it("links are resolved again when the list of notes arrives later", () => {
    const { container, rerender } = render(<NoteEditor value={"[[Target]]\n"} onChange={vi.fn()} notes={[]} mode="live" />);
    expect(container.querySelector(".cm-live-unresolved")).not.toBeNull();
    rerender(<NoteEditor value={"[[Target]]\n"} onChange={vi.fn()} notes={NOTES} mode="live" />);
    expect(container.querySelector(".cm-live-unresolved")).toBeNull();
    expect(container.querySelector(".cm-live-wikilink")).not.toBeNull();
  });

  it.each(["live", "source"] as const)("keeps CRLF notes byte for byte in %s mode", (mode) => {
    const text = "# T\r\n\r\ntext  \r\n- [ ] a\r\n";
    const onChange = vi.fn();
    const { container } = render(<NoteEditor value={text} onChange={onChange} mode={mode} />);
    expect(onChange).not.toHaveBeenCalled();
    const view = viewOf(container);
    view.dispatch({ changes: { from: view.state.doc.length, insert: "more" } });
    expect(onChange).toHaveBeenLastCalledWith(`${text}more`);
  });

  it("an outside replacement (reload of the server version) replaces the text, not undoable", () => {
    const onChange = vi.fn();
    const { container, rerender } = render(<NoteEditor value={"one\n"} onChange={onChange} mode="live" />);
    rerender(<NoteEditor value={"two\r\nlines\r\n"} onChange={onChange} mode="live" />);
    const view = viewOf(container);
    expect(documentText(view.state)).toBe("two\r\nlines\r\n");
    expect(undo(view)).toBe(false);
  });
});
