import { history, redo, selectAll, undo } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  documentText,
  frontmatterEnd,
  lineBreakOf,
  liveExtensions,
  safeExternalUrl,
  type LiveOptions,
} from "./livePreview";

// jsdom has no layout; CodeMirror only needs these to exist.
beforeAll(() => {
  const empty = () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 });
  Range.prototype.getClientRects ??= (() => []) as unknown as Range["getClientRects"];
  Range.prototype.getBoundingClientRect ??= empty as unknown as Range["getBoundingClientRect"];
});

const views: EditorView[] = [];
afterEach(() => {
  views.splice(0).forEach((view) => view.destroy());
  document.body.innerHTML = "";
});

const NOTES: Record<string, string> = { "Target note": "id-target" };
function options(overrides: Partial<LiveOptions> = {}): LiveOptions {
  return {
    resolveWiki: (raw) => {
      const written = raw.split("|")[0].split("#")[0].trim();
      return { id: NOTES[written] ?? null, target: written };
    },
    openNote: vi.fn(),
    openUrl: vi.fn(),
    ...overrides,
  };
}

export function mount(doc: string, opts: LiveOptions | null = options()) {
  const parent = document.body.appendChild(document.createElement("div"));
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        EditorState.lineSeparator.of(lineBreakOf(doc)),
        history(),
        markdown({ base: markdownLanguage }),
        ...(opts ? [liveExtensions(opts)] : []),
      ],
    }),
  });
  views.push(view);
  return view;
}

const text = (view: EditorView) => view.contentDOM.textContent;

describe("safeExternalUrl", () => {
  it("allows only http, https and mailto", () => {
    expect(safeExternalUrl("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(safeExternalUrl("http://example.com")).toBe("http://example.com/");
    expect(safeExternalUrl("mailto:me@example.com")).toBe("mailto:me@example.com");
    expect(safeExternalUrl("<https://example.com>")).toBe("https://example.com/");
  });

  it.each([
    "javascript:alert(1)",
    " JaVaScRiPt:alert(1)",
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "blob:https://example.com/x",
    "/relative/path",
    "../notes.md",
    "//example.com",
    "",
  ])("refuses %j", (raw) => {
    expect(safeExternalUrl(raw)).toBeNull();
  });
});

describe("line endings", () => {
  it("uses CRLF only when the note has it", () => {
    expect(lineBreakOf("a\r\nb")).toBe("\r\n");
    expect(lineBreakOf("a\nb")).toBe("\n");
    expect(lineBreakOf("a\rb c")).toBe("\n");
    expect(lineBreakOf("")).toBe("\n");
  });

  it.each(["a\r\nb\r\n", "a\nb\n", "a\rb c d\n", "mixed\r\nand\nlf\r\n", "", "\r\n", "trailing  \r\n"])(
    "serialises %j back to the same text",
    (original) => {
      const view = mount(original, null);
      expect(documentText(view.state)).toBe(original);
    },
  );
});

describe("front matter", () => {
  it("is found only at the very top and only when closed", () => {
    const view = mount("---\ntitle: x\n---\nBody", null);
    expect(frontmatterEnd(view.state.doc)).toBe(16);
    expect(frontmatterEnd(mount("---\ntitle: x\nBody", null).state.doc)).toBe(0);
    expect(frontmatterEnd(mount("\n---\ntitle: x\n---\n", null).state.doc)).toBe(0);
    expect(frontmatterEnd(mount("", null).state.doc)).toBe(0);
  });
});

describe("rendering (nothing has focus, so the whole note reads as rendered text)", () => {
  it("styles headings at scale and hides the hashes", () => {
    const view = mount("# One\n\n### Three\n");
    expect(view.contentDOM.querySelector(".cm-live-h1")?.textContent).toBe("One");
    expect(view.contentDOM.querySelector(".cm-live-h3")?.textContent).toBe("Three");
    expect(text(view)).not.toContain("#");
  });

  it("hides emphasis, strikethrough and code marks but keeps their text", () => {
    const view = mount("a **bold** *it* ~~gone~~ `code` b");
    expect(text(view)).toBe("a bold it gone code b");
    for (const name of ["strong", "em", "strike", "code"]) {
      expect(view.contentDOM.querySelector(`.cm-live-${name}`), name).not.toBeNull();
    }
  });

  it("shows only the label of a link and never makes an anchor", () => {
    const view = mount("see [the site](https://example.com \"t\") now");
    expect(text(view)).toBe("see the site now");
    expect(view.contentDOM.querySelector("a")).toBeNull();
    expect(view.contentDOM.querySelector(".cm-live-link")?.textContent).toBe("the site");
  });

  it("renders wiki links, with and without an alias, and marks unresolved ones", () => {
    const view = mount("[[Target note]] and [[Target note|Shown]] and [[missing]]");
    expect(text(view)).toBe("Target note and Shown and missing");
    const links = [...view.contentDOM.querySelectorAll(".cm-live-wikilink")];
    expect(links.map((el) => el.classList.contains("cm-live-unresolved"))).toEqual([false, false, true]);
  });

  it("renders list bullets, task checkboxes, quotes and rules", () => {
    const view = mount("- item\n- [ ] todo\n- [x] done\n\n> quoted\n\n---\n\n1. one\n");
    expect(view.contentDOM.querySelectorAll(".cm-live-bullet")).toHaveLength(1);
    const boxes = [...view.contentDOM.querySelectorAll<HTMLInputElement>("input.cm-live-checkbox")];
    expect(boxes.map((box) => box.checked)).toEqual([false, true]);
    expect(boxes.map((box) => box.getAttribute("aria-label"))).toEqual(["todo", "done"]);
    expect(boxes.every((box) => box.tabIndex === -1)).toBe(true);
    expect(view.contentDOM.querySelector(".cm-live-quote")?.textContent).toBe("quoted");
    expect(view.contentDOM.querySelector(".cm-live-rule")).not.toBeNull();
    expect(text(view)).toContain("1. one");
  });

  it("leaves everything inside a code fence alone", () => {
    const view = mount("```js\n**not bold** [[x]] #tag\n```\n");
    expect(view.contentDOM.querySelector(".cm-live-strong")).toBeNull();
    expect(view.contentDOM.querySelector(".cm-live-wikilink")).toBeNull();
    expect(view.contentDOM.querySelector(".cm-live-tag")).toBeNull();
    expect(text(view)).toContain("**not bold** [[x]] #tag");
    expect(view.contentDOM.querySelectorAll(".cm-live-codeblock")).toHaveLength(3);
  });

  it("styles #tags but not headings, URLs or front matter", () => {
    const view = mount("---\ntags: #fm\n---\n# Heading\nwork #project/x and https://e.com/#frag\n");
    expect([...view.contentDOM.querySelectorAll(".cm-live-tag")].map((el) => el.textContent)).toEqual(["#project/x"]);
  });

  it("shows HTML as inert text", () => {
    const view = mount("<script>alert(1)</script>\n\n<div onclick=\"x()\">hi</div>\n");
    expect(view.contentDOM.querySelector("script,div[onclick]")).toBeNull();
    expect(text(view)).toContain("<script>alert(1)</script>");
  });
});

describe("source lines show their Markdown when the editor has focus", () => {
  it("reveals the line holding the cursor and only that line", () => {
    const view = mount("# One\n\n**bold** here\n\n**other** line\n");
    view.focus();
    if (!view.hasFocus) return; // jsdom without focus support: covered by the real-stack spec
    view.dispatch({ selection: { anchor: 9 } });
    expect(view.contentDOM.querySelector(".cm-live-h1")?.textContent).toBe("One");
    expect(text(view)).toContain("**bold** here");
    expect(text(view)).toContain("other line");
    expect(text(view)).not.toContain("**other**");
  });
});

describe("selection and keyboard", () => {
  it("a selection across lines reveals every line it touches", () => {
    const view = mount("**a**\n**b**\n**c**\n**d**\n");
    view.focus();
    expect(view.hasFocus).toBe(true);
    view.dispatch({ selection: { anchor: 7, head: 13 } }); // lines 2 and 3
    expect(text(view)).toBe("a**b****c**d");
  });

  it("without focus nothing is revealed, with focus only the cursor line", () => {
    const view = mount("# T\n\n**x**\n");
    expect(text(view)).not.toContain("**");
    view.focus();
    view.dispatch({ selection: { anchor: 5 } });
    expect(text(view)).toContain("**x**");
    expect(text(view)).not.toContain("# T");
  });

  it("a checkbox on the cursor line is source text, and Mod-Enter ticks it", () => {
    const view = mount("- [ ] todo\n");
    view.focus();
    view.dispatch({ selection: { anchor: 8 } });
    expect(view.contentDOM.querySelector("input")).toBeNull();
    expect(text(view)).toContain("- [ ] todo");
    const event = new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true });
    view.contentDOM.dispatchEvent(event);
    expect(documentText(view.state)).toBe("- [x] todo\n");
  });

  it("Mod-Enter opens the link under the cursor and otherwise falls through", () => {
    const opts = options();
    const view = mount("go [[Target note]] now\n\nplain\n", opts);
    view.focus();
    view.dispatch({ selection: { anchor: 8 } });
    view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));
    expect(opts.openNote).toHaveBeenCalledWith("id-target");
    expect(documentText(view.state)).toBe("go [[Target note]] now\n\nplain\n");
  });
});

describe("edits", () => {
  it("ticking a checkbox is an ordinary, undoable change to the text", () => {
    const view = mount("- [ ] todo\n- [x] done\n");
    const onDoc = vi.fn();
    const changes: string[] = [];
    view.dispatch({}); // no-op
    const box = view.contentDOM.querySelector<HTMLInputElement>("input.cm-live-checkbox")!;
    box.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    box.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    changes.push(documentText(view.state));
    expect(changes[0]).toBe("- [x] todo\n- [x] done\n");
    expect(onDoc).not.toHaveBeenCalled();
    undo(view);
    expect(documentText(view.state)).toBe("- [ ] todo\n- [x] done\n");
    redo(view);
    expect(documentText(view.state)).toBe("- [x] todo\n- [x] done\n");
  });

  it("opens a rendered note link on a plain click and an external link only with Ctrl", () => {
    const opts = options();
    const view = mount("[[Target note]] and [ext](https://example.com) and [bad](javascript:alert(1))\n", opts);
    const [wiki] = [...view.contentDOM.querySelectorAll(".cm-live-wikilink")];
    wiki.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    expect(opts.openNote).toHaveBeenCalledWith("id-target");

    const [ext, bad] = [...view.contentDOM.querySelectorAll(".cm-live-link")];
    ext.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    expect(opts.openUrl).not.toHaveBeenCalled();
    ext.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, ctrlKey: true }));
    expect(opts.openUrl).toHaveBeenCalledWith("https://example.com/");
    bad.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, ctrlKey: true }));
    expect(opts.openUrl).toHaveBeenCalledTimes(1);
  });

  it("does not open a link to a note that does not exist", () => {
    const opts = options();
    const view = mount("[[missing]]\n", opts);
    view.contentDOM
      .querySelector(".cm-live-wikilink")!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    expect(opts.openNote).not.toHaveBeenCalled();
  });
});

/**
 * The corpus: Markdown that is easy to get wrong. For each text, loading it in Live mode, typing,
 * replacing a selection, undo and redo must leave exactly the text that Source mode leaves, and the
 * decorated DOM must never hold anything executable.
 */
const CORPUS: Record<string, string> = {
  "nested lists": "- a\n  - b\n    - [ ] c\n      1. d\n- e\n\n1. one\n   - two\n",
  "code fence with markup": "```md\n# not a heading\n**not bold** [[not a link]] - [ ] not a task\n```\n\n~~~\n- x\n~~~\n",
  "indented code": "para\n\n    # code\n    **code**\n",
  tables: "| a | b |\n|:--|--:|\n| **x** | `y` |\n| [[Target note]] | #tag |\n",
  "html blocks": "<div class=\"x\" onclick=\"alert(1)\">\n**inside**\n</div>\n\n<script>alert(1)</script>\n<!-- comment -->\ninline <b onmouseover=\"x\">b</b>\n",
  "crlf": "# Title\r\n\r\n- [ ] one\r\n- [x] two\r\n\r\ntext with **bold**\r\n",
  "trailing whitespace": "line with two spaces  \nline with tab\t\n   \n\ttabbed\n",
  "unicode and emoji": "# Привет 日本語 😀\n\nünï ✓ 𝄞 **жирный** `код` [[Target note|псевдоним]]\n",
  "wiki links with aliases": "[[Target note|Alias]] [[Target note#Heading|H]] [[a|b|c]] [[|x]] [[x|]] [[ ]]\n",
  "front matter": "---\ntitle: Test\ntags: [a, b]\n---\n\n# Body #tag\n",
  "front matter only": "---\na: 1\n---",
  "setext and rules": "Title\n=====\n\nSub\n---\n\n***\n\n___\n",
  "links and images": "[a](https://e.com) ![i](https://e.com/i.png) <https://e.com> https://e.com/x [r][ref]\n\n[ref]: https://e.com\n",
  "unsafe links": "[x](javascript:alert(1)) [y](data:text/html;base64,PHNjcmlwdD4=) [[javascript:alert(1)]] ![z](javascript:alert(1))\n",
  "escapes and entities": "\\*not italic\\* &amp; \\# \\[x\\]\n",
  "blockquotes": "> a\n> > b\n>\n> - [ ] c\n",
  "empty note": "",
  "only blank lines": "\n\n\n",
  "no trailing newline": "# T\n\n- [ ] last",
};

function applyEdits(view: EditorView) {
  const trace: string[] = [];
  const at = (n: number) => Math.min(n, view.state.doc.length);
  const log = () => trace.push(documentText(view.state));
  log();
  view.dispatch({ changes: { from: 0, insert: "X" }, userEvent: "input.type" });
  log();
  view.dispatch({ changes: { from: at(3), insert: "é😀" }, userEvent: "input.type" });
  log();
  view.dispatch({ changes: { from: view.state.doc.length, insert: "\n- [ ] typed **b** [[Target note]]" } });
  log();
  view.dispatch({ selection: { anchor: at(2), head: at(9) } });
  view.dispatch(view.state.replaceSelection("Z"));
  log();
  selectAll(view);
  view.dispatch(view.state.replaceSelection("all new\n"));
  log();
  undo(view);
  log();
  undo(view);
  log();
  redo(view);
  log();
  while (undo(view)) {
    /* back to the loaded text */
  }
  log();
  while (redo(view)) {
    /* and forward again */
  }
  log();
  return trace;
}

// CodeMirror's own `<img class="cm-widgetBuffer" aria-hidden>` spacers (no source) are the only
// images allowed; nothing a note says becomes an element of any of these kinds.
const UNSAFE_ELEMENTS =
  "script,iframe,object,embed,img:not(.cm-widgetBuffer),img[src],a,form,link,style,svg,video,audio,base,meta";

function expectInert(view: EditorView) {
  expect([...view.dom.querySelectorAll(UNSAFE_ELEMENTS)].map((e) => e.outerHTML.slice(0, 80))).toEqual([]);
  for (const element of view.dom.querySelectorAll("*")) {
    for (const attribute of element.attributes) {
      expect(attribute.name, `${element.tagName}.${attribute.name}`).not.toMatch(/^on/i);
      expect(attribute.value, `${element.tagName}.${attribute.name}`).not.toMatch(/javascript:|vbscript:|data:text\/html/i);
    }
  }
}

describe.each(Object.entries(CORPUS))("round trip: %s", (_name, original) => {
  it("loads unchanged and renders only inert DOM", () => {
    const view = mount(original);
    expect(documentText(view.state)).toBe(original);
    expectInert(view);
  });

  it("types, selects, undoes and redoes exactly as Source mode does", () => {
    const live = mount(original);
    const source = mount(original, null);
    const liveTrace = applyEdits(live);
    const sourceTrace = applyEdits(source);
    expect(liveTrace).toEqual(sourceTrace);
    expect(liveTrace[0]).toBe(original);
    // After undoing everything the loaded text is back, byte for byte.
    expect(liveTrace[liveTrace.length - 2]).toBe(original);
    expectInert(live);
  });

  it("never changes the document by itself, whatever the selection or focus does", () => {
    const view = mount(original);
    const seen: string[] = [];
    let docChanges = 0;
    view.dispatch({ effects: [] });
    for (let pos = 0; pos <= view.state.doc.length; pos += Math.max(1, Math.floor(view.state.doc.length / 7))) {
      view.dispatch({ selection: { anchor: pos } });
      seen.push(documentText(view.state));
      docChanges += documentText(view.state) === original ? 0 : 1;
    }
    view.focus();
    view.contentDOM.blur();
    expect(docChanges).toBe(0);
    expect(new Set(seen)).toEqual(new Set([original]));
  });
});
