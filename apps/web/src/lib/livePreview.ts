/**
 * Live preview for the note editor (UX-06, ADR-0056): CodeMirror 6 decorations only.
 *
 * The document is never changed by anything in this file except two explicit user actions, both
 * ordinary transactions that reach `session.change(text)` through the editor's update listener
 * (ADR-0054): ticking a task checkbox (`[ ]` <-> `[x]`) and Mod-Enter on a task line. Decorations
 * hide or style Markdown syntax on lines that do not hold the cursor or a selection, so the text on
 * disk is the text that was typed (AGENTS.md section 8). Nothing here creates HTML from note
 * content: every widget is built with DOM calls from constants, content only ever reaches the DOM
 * as text the editor itself renders, and a link is opened only when its scheme is on a short list.
 */
import { syntaxTree } from "@codemirror/language";
import {
  type EditorState,
  type Extension,
  Prec,
  type Range,
  StateEffect,
  type Text,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";

export interface LiveOptions {
  /** The note a `[[…]]` link (the text between the brackets) points at, or `null` id when none. */
  resolveWiki: (raw: string) => { id: string | null; target: string };
  /** A link to a note was activated. */
  openNote: (id: string) => void;
  /** Open an external link (already checked by `safeExternalUrl`); the default opens a new tab. */
  openUrl?: (url: string) => void;
}

/** Sent after the list of notes changes, so `[[links]]` are resolved again. */
export const refreshLive = StateEffect.define<null>();

/** Schemes an external link may open. Everything else (`javascript:`, `data:`, …) is never opened. */
const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/**
 * The URL to open for a link written in a note, or `null` when it must not be opened: relative
 * links, unparsable text and every scheme except http, https and mailto. The URL parser applies the
 * same whitespace and control-character stripping a browser would, so `java\tscript:` is refused.
 */
export function safeExternalUrl(raw: string): string | null {
  let text = raw.trim();
  if (text.startsWith("<") && text.endsWith(">")) {
    text = text.slice(1, -1);
  }
  try {
    const url = new URL(text);
    return SAFE_SCHEMES.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * The line ending a note uses: `\r\n` when it has any, else `\n`. Setting this as the editor's
 * line separator means `\r`, U+2028 and a lone `\n` inside a CRLF note are kept as characters and
 * the text serialises back to exactly the bytes that were loaded (AGENTS.md section 8).
 */
export function lineBreakOf(text: string): "\n" | "\r\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/** The document as the string that is saved: lines joined with the note's own line ending. */
export function documentText(state: EditorState): string {
  return state.doc.sliceString(0, state.doc.length, state.lineBreak);
}

// --- widgets ------------------------------------------------------------------------------------

class BulletWidget extends WidgetType {
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-live-bullet";
    span.setAttribute("aria-hidden", "true");
    span.textContent = "•";
    return span;
  }
}

class RuleWidget extends WidgetType {
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-live-rule";
    span.setAttribute("aria-hidden", "true");
    return span;
  }
}

/** Toggle the task marker at `pos` (`[ ]` <-> `[x]`/`[X]`). A normal, undoable transaction. */
function toggleMarkerAt(view: EditorView, pos: number): boolean {
  const marker = view.state.sliceDoc(pos, pos + 3);
  if (!/^\[[ xX]\]$/.test(marker)) {
    return false;
  }
  view.dispatch({
    changes: { from: pos + 1, to: pos + 2, insert: marker[1] === " " ? "x" : " " },
    userEvent: "input.toggle-task",
  });
  return true;
}

class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly label: string,
  ) {
    super();
  }
  eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked && other.label === this.label;
  }
  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-live-checkbox";
    box.checked = this.checked;
    // Not a tab stop (a long list would trap Tab); the keyboard way is Mod-Enter on the line.
    box.tabIndex = -1;
    box.setAttribute("aria-label", this.label);
    // The press must not move the cursor (that would turn the line back into source).
    box.addEventListener("mousedown", (event) => event.preventDefault());
    box.addEventListener("click", (event) => {
      event.preventDefault();
      toggleMarkerAt(view, view.posAtDOM(box));
    });
    return box;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

const bullet = Decoration.replace({ widget: new BulletWidget() });
const rule = Decoration.replace({ widget: new RuleWidget() });
const hidden = Decoration.replace({});

// --- decorations --------------------------------------------------------------------------------

interface Target {
  from: number;
  to: number;
  kind: "wiki" | "url";
  /** Note id (wiki) or the URL as written (url); `null` when a note does not exist. */
  value: string | null;
  /** The line is shown as rendered text, not as source. */
  rendered: boolean;
}

interface Built {
  decorations: DecorationSet;
  targets: Target[];
}

/** The end of a leading `---` … `---` front matter block, or 0 when the note has none. */
export function frontmatterEnd(doc: Text): number {
  if (doc.lines < 2 || doc.line(1).text.trimEnd() !== "---") {
    return 0;
  }
  for (let number = 2; number <= doc.lines; number += 1) {
    const text = doc.line(number).text.trimEnd();
    if (text === "---" || text === "...") {
      return doc.line(number).to;
    }
  }
  return 0;
}

const WIKI_LINK = /\[\[([^[\]\n]+?)\]\]/g;
const TAG = /(^|[^\p{L}\p{N}_&/#])#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gu;

function build(view: EditorView, options: LiveOptions): Built {
  const { state } = view;
  const doc = state.doc;
  const lineAt = (pos: number) => doc.lineAt(pos);

  // Lines holding a cursor or part of a selection show their Markdown; without focus the whole
  // note reads as rendered text.
  const active = new Set<number>();
  if (view.hasFocus) {
    for (const range of state.selection.ranges) {
      for (let n = lineAt(range.from).number; n <= lineAt(range.to).number; n += 1) {
        active.add(n);
      }
    }
  }
  const lineActive = (pos: number) => active.has(lineAt(pos).number);
  const spanActive = (from: number, to: number) => {
    for (let n = lineAt(from).number; n <= lineAt(to).number; n += 1) {
      if (active.has(n)) return true;
    }
    return false;
  };

  const lineClasses = new Map<number, Set<string>>();
  const addLine = (pos: number, ...classes: string[]) => {
    const start = lineAt(pos).from;
    const set = lineClasses.get(start) ?? new Set<string>();
    classes.forEach((name) => set.add(name));
    lineClasses.set(start, set);
  };
  const addLines = (from: number, to: number, ...classes: string[]) => {
    for (let n = lineAt(from).number; n <= lineAt(to).number; n += 1) {
      addLine(doc.line(n).from, ...classes);
    }
  };

  const marks: Range<Decoration>[] = [];
  const mark = (from: number, to: number, className: string, attributes?: Record<string, string>) => {
    if (from < to) {
      marks.push(Decoration.mark({ class: className, attributes }).range(from, to));
    }
  };
  const replaces: { from: number; to: number; deco: Decoration }[] = [];
  const replace = (from: number, to: number, deco: Decoration) => {
    if (from < to) replaces.push({ from, to, deco });
  };
  const targets: Target[] = [];
  const skip: [number, number][] = [];
  const skipped = (from: number, to: number) => skip.some(([a, b]) => from < b && to > a);

  const fmEnd = frontmatterEnd(doc);
  if (fmEnd > 0) {
    addLines(0, fmEnd, "cm-live-frontmatter");
    skip.push([0, fmEnd]);
  }

  const { from: vFrom, to: vTo } = view.viewport;
  syntaxTree(state).iterate({
    from: vFrom,
    to: vTo,
    enter: (ref) => {
      const { name, from, to } = ref;
      if (name === "Document") return undefined;
      if (fmEnd > 0 && from < fmEnd) return false;

      const inTable = () => {
        for (let p = ref.node.parent; p; p = p.parent) if (p.name === "Table") return true;
        return false;
      };
      /** Hide a syntax mark on rendered lines, show it dimmed on source lines. */
      const syntax = (a: number, b: number, raw: boolean, extra = 0) => {
        if (raw || inTable()) mark(a, b, "cm-live-mark");
        else replace(a, b + extra, hidden);
      };
      const spaceAfter = (pos: number) => (doc.sliceString(pos, pos + 1) === " " ? 1 : 0);

      if (/^ATXHeading[1-6]$/.test(name)) {
        addLine(from, "cm-live-h", `cm-live-h${name.slice(10)}`);
        return undefined;
      }
      if (name === "SetextHeading1" || name === "SetextHeading2") {
        const last = lineAt(to).number;
        for (let n = lineAt(from).number; n < last; n += 1) {
          addLine(doc.line(n).from, "cm-live-h", `cm-live-h${name.slice(13)}`);
        }
        return undefined;
      }
      switch (name) {
        case "HeaderMark": {
          const atx = ref.node.parent?.name.startsWith("ATX");
          if (atx) syntax(from, to, lineActive(from), spaceAfter(to));
          else mark(from, to, "cm-live-mark");
          return undefined;
        }
        case "StrongEmphasis":
          mark(from, to, "cm-live-strong");
          return undefined;
        case "Emphasis":
          mark(from, to, "cm-live-em");
          return undefined;
        case "Strikethrough":
          mark(from, to, "cm-live-strike");
          return undefined;
        case "InlineCode":
          mark(from, to, "cm-live-code");
          skip.push([from, to]);
          return undefined;
        case "EmphasisMark":
        case "StrikethroughMark":
        case "CodeMark": {
          const parent = ref.node.parent;
          if (!parent || parent.name === "FencedCode") return undefined;
          syntax(from, to, spanActive(parent.from, parent.to));
          return undefined;
        }
        case "Escape":
          syntax(from, from + 1, lineActive(from));
          return undefined;
        case "FencedCode": {
          addLines(from, to, "cm-live-codeblock");
          addLine(from, "cm-live-fence");
          if (ref.node.getChildren("CodeMark").length >= 2) addLine(to, "cm-live-fence");
          skip.push([from, to]);
          return false;
        }
        case "CodeBlock":
          addLines(from, to, "cm-live-codeblock");
          skip.push([from, to]);
          return false;
        case "Blockquote":
          addLines(from, to, "cm-live-quote");
          return undefined;
        case "QuoteMark":
          syntax(from, to, lineActive(from), spaceAfter(to));
          return undefined;
        case "ListMark": {
          const list = ref.node.parent?.parent?.name;
          if (list !== "BulletList") {
            mark(from, to, "cm-live-listnum");
            return undefined;
          }
          const task = ref.node.nextSibling?.name === "Task";
          if (lineActive(from)) mark(from, to, "cm-live-mark");
          else replace(from, to, task ? hidden : bullet);
          return undefined;
        }
        case "Task":
          return undefined;
        case "TaskMarker": {
          const checked = doc.sliceString(from, to).toLowerCase() === "[x]";
          if (checked) mark(to, lineAt(from).to, "cm-live-done");
          if (lineActive(from)) {
            mark(from, to, "cm-live-mark");
          } else {
            const line = lineAt(from);
            const text = doc.sliceString(to, line.to).trim().slice(0, 80);
            replace(from, to, Decoration.replace({ widget: new CheckboxWidget(checked, text || "Task item") }));
          }
          return undefined;
        }
        case "HorizontalRule":
          if (lineActive(from)) mark(from, to, "cm-live-mark");
          else replace(from, to, rule);
          return undefined;
        case "Image":
          mark(from, to, "cm-live-image");
          skip.push([from, to]);
          return false;
        case "Link": {
          const parts = ref.node.getChildren("LinkMark");
          const url = ref.node.getChild("URL");
          const raw = spanActive(from, to);
          if (parts.length >= 4 && url) {
            mark(parts[0].to, parts[1].from, "cm-live-link");
            if (raw) {
              mark(parts[0].from, parts[0].to, "cm-live-mark");
              mark(parts[1].from, to, "cm-live-mark");
            } else {
              replace(parts[0].from, parts[0].to, hidden);
              replace(parts[1].from, to, hidden);
            }
            targets.push({
              from,
              to,
              kind: "url",
              value: doc.sliceString(url.from, url.to),
              rendered: !raw,
            });
          }
          if (url) skip.push([url.from, url.to]);
          return undefined;
        }
        case "Autolink":
        case "URL": {
          if (name === "URL" && ["Link", "Image", "Autolink"].includes(ref.node.parent?.name ?? "")) {
            return undefined;
          }
          mark(from, to, "cm-live-link");
          skip.push([from, to]);
          targets.push({
            from,
            to,
            kind: "url",
            value: doc.sliceString(name === "URL" ? from : ref.node.getChild("URL")?.from ?? from, to).replace(/^<|>$/g, ""),
            rendered: !spanActive(from, to),
          });
          return undefined;
        }
        case "HTMLBlock":
        case "HTMLTag":
        case "CommentBlock":
        case "Comment":
        case "ProcessingInstruction":
          mark(from, to, "cm-live-html");
          skip.push([from, to]);
          return false;
        case "Table":
          addLines(from, to, "cm-live-table");
          return undefined;
        case "TableDelimiter":
          mark(from, to, "cm-live-mark");
          return undefined;
        default:
          return undefined;
      }
    },
  });

  // `[[wiki links]]` and `#tags` are not Markdown syntax, so they are found line by line outside
  // code, links' URLs, HTML and front matter.
  for (let n = lineAt(vFrom).number; n <= lineAt(vTo).number; n += 1) {
    const line = doc.line(n);
    const text = line.text;
    if (text.includes("[[")) {
      for (const match of text.matchAll(WIKI_LINK)) {
        const from = line.from + (match.index ?? 0);
        const to = from + match[0].length;
        if (skipped(from, to)) continue;
        const raw = match[1];
        const found = options.resolveWiki(raw);
        const rendered = !active.has(n);
        const pipe = raw.indexOf("|");
        const secondPipe = pipe < 0 ? -1 : raw.indexOf("|", pipe + 1);
        const aliasEnd = secondPipe < 0 ? raw.length : secondPipe;
        const hasAlias = pipe >= 0 && aliasEnd > pipe + 1;
        const labelFrom = from + 2 + (hasAlias ? pipe + 1 : 0);
        const labelTo = from + 2 + (hasAlias ? aliasEnd : raw.length);
        const className = found.id ? "cm-live-wikilink" : "cm-live-wikilink cm-live-unresolved";
        // A fixed title: note text never becomes an attribute value.
        const attributes = found.id ? undefined : { title: "No note with this name yet" };
        if (rendered) {
          replace(from, labelFrom, hidden);
          replace(labelTo, to, hidden);
          mark(labelFrom, labelTo, className, attributes);
        } else {
          mark(from, to, className, attributes);
        }
        targets.push({ from, to, kind: "wiki", value: found.id, rendered });
        skip.push([from, to]);
      }
    }
    if (text.includes("#")) {
      for (const match of text.matchAll(TAG)) {
        if (!/\p{L}/u.test(match[2])) continue;
        const from = line.from + (match.index ?? 0) + match[1].length;
        const to = from + 1 + match[2].length;
        if (!skipped(from, to)) mark(from, to, "cm-live-tag");
      }
    }
  }

  // Replacements may not overlap; the first (leftmost) wins.
  replaces.sort((a, b) => a.from - b.from || a.to - b.to);
  const all: Range<Decoration>[] = [...marks];
  let end = -1;
  for (const item of replaces) {
    if (item.from >= end) {
      all.push(item.deco.range(item.from, item.to));
      end = item.to;
    }
  }
  for (const [start, classes] of lineClasses) {
    all.push(Decoration.line({ class: [...classes].join(" ") }).range(start));
  }
  return { decorations: Decoration.set(all, true), targets };
}

const livePlugin = (options: LiveOptions) =>
  ViewPlugin.fromClass(
    class {
      built: Built;
      constructor(view: EditorView) {
        this.built = build(view, options);
      }
      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.selectionSet ||
          update.focusChanged ||
          syntaxTree(update.startState) !== syntaxTree(update.state) ||
          update.transactions.some((tr) => tr.effects.some((effect) => effect.is(refreshLive)))
        ) {
          this.built = build(update.view, options);
        }
      }
    },
    { decorations: (plugin) => plugin.built.decorations },
  );

// --- actions ------------------------------------------------------------------------------------

function activate(target: Target, options: LiveOptions): boolean {
  if (target.kind === "wiki") {
    if (target.value) options.openNote(target.value);
    return true;
  }
  const url = target.value === null ? null : safeExternalUrl(target.value);
  if (url) {
    (options.openUrl ?? ((href) => window.open(href, "_blank", "noopener,noreferrer")))(url);
  }
  return true;
}

const targetsOf = (plugin: { built: Built } | null): Target[] => (plugin ? plugin.built.targets : []);

/** Mod-Enter: open the link under the cursor, else tick/untick the task on the cursor's line. */
function openOrToggle(view: EditorView, getPlugin: () => { built: Built } | null, options: LiveOptions): boolean {
  const head = view.state.selection.main.head;
  const hit = targetsOf(getPlugin()).find((t) => head >= t.from && head <= t.to);
  if (hit) return activate(hit, options);
  const line = view.state.doc.lineAt(head);
  const task = /^(\s*(?:[-*+]|\d+[.)])\s+)\[[ xX]\]/.exec(line.text);
  return task ? toggleMarkerAt(view, line.from + task[1].length) : false;
}

export const liveTheme = EditorView.theme({
  // More specific than the base theme's `.cm-scroller`, which sets the mono font for Source.
  "&.cm-live .cm-scroller": { fontFamily: "var(--font-ui)", fontSize: "var(--fs-md)" },
  ".cm-live-mark": { color: "var(--text-3)" },
  ".cm-live-h": { fontWeight: "650" },
  ".cm-live-h1": { fontSize: "var(--fs-2xl)", lineHeight: "var(--lh-2xl)", paddingTop: "var(--s-2)" },
  ".cm-live-h2": { fontSize: "var(--fs-xl)", lineHeight: "var(--lh-xl)", paddingTop: "var(--s-2)" },
  ".cm-live-h3": { fontSize: "var(--fs-lg)", lineHeight: "var(--lh-lg)", paddingTop: "var(--s-1)" },
  ".cm-live-h4, .cm-live-h5, .cm-live-h6": { fontSize: "var(--fs-md)" },
  ".cm-live-h5, .cm-live-h6": { color: "var(--text-2)" },
  ".cm-live-strong": { fontWeight: "700" },
  ".cm-live-em": { fontStyle: "italic" },
  ".cm-live-strike": { textDecoration: "line-through", color: "var(--text-2)" },
  ".cm-live-code, .cm-live-html": {
    fontFamily: "var(--font-mono)",
    fontSize: "0.9em",
    backgroundColor: "var(--bg-hover)",
    borderRadius: "var(--r-sm)",
  },
  ".cm-live-html": { color: "var(--text-2)" },
  ".cm-live-link, .cm-live-wikilink": {
    color: "var(--accent-text)",
    textDecoration: "underline",
    textUnderlineOffset: "2px",
  },
  ".cm-live-wikilink": { cursor: "pointer" },
  ".cm-live-unresolved": {
    color: "var(--text-2)",
    textDecorationStyle: "dashed",
  },
  ".cm-live-image": { color: "var(--text-2)", fontFamily: "var(--font-mono)", fontSize: "0.9em" },
  ".cm-live-tag": {
    color: "var(--accent-text)",
    backgroundColor: "var(--accent-soft)",
    borderRadius: "var(--r-sm)",
    padding: "0 var(--s-1)",
  },
  ".cm-live-quote": {
    borderLeft: "3px solid var(--border-strong)",
    paddingLeft: "var(--s-3)",
    color: "var(--text-2)",
  },
  ".cm-live-listnum": { color: "var(--text-2)" },
  ".cm-live-bullet": { color: "var(--text-2)", display: "inline-block", width: "1.1em" },
  ".cm-live-checkbox": {
    margin: "0 var(--s-1) 0 0",
    verticalAlign: "middle",
    accentColor: "var(--accent)",
    cursor: "pointer",
  },
  ".cm-live-done": { color: "var(--text-3)", textDecoration: "line-through" },
  ".cm-live-rule": {
    display: "inline-block",
    width: "100%",
    height: "0",
    borderTop: "1px solid var(--border-strong)",
    verticalAlign: "middle",
  },
  ".cm-live-codeblock, .cm-live-table, .cm-live-frontmatter": {
    fontFamily: "var(--font-mono)",
    fontSize: "var(--fs-base)",
    backgroundColor: "var(--bg-hover)",
    paddingLeft: "var(--s-3)",
    paddingRight: "var(--s-3)",
  },
  ".cm-live-fence": { color: "var(--text-3)", fontSize: "var(--fs-sm)" },
  ".cm-live-frontmatter": { color: "var(--text-2)" },
});

/**
 * The extensions that make the editor "Live". Added and removed through a Compartment, so changing
 * mode keeps the document, the cursor and the undo history.
 */
export function liveExtensions(options: LiveOptions): Extension {
  const plugin = livePlugin(options);
  let latest: EditorView | null = null;
  const current = () => (latest ? latest.plugin(plugin) : null);
  return [
    plugin,
    liveTheme,
    EditorView.editorAttributes.of({ class: "cm-live" }),
    ViewPlugin.define((view) => {
      latest = view;
      return { destroy: () => (latest = null) };
    }),
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (event.button !== 0 || !(event.target instanceof Element)) return false;
        const element = event.target.closest(".cm-live-wikilink, .cm-live-link");
        if (!element) return false;
        const pos = view.posAtDOM(element);
        const hit = targetsOf(current()).find((t) => pos >= t.from && pos <= t.to);
        if (!hit) return false;
        const modifier = event.ctrlKey || event.metaKey;
        // A rendered note link opens on a plain click; a raw one, and any external link, need
        // Ctrl/Cmd so that clicking to edit or to select never navigates away.
        if (!(modifier || (hit.kind === "wiki" && hit.rendered))) return false;
        event.preventDefault();
        return activate(hit, options);
      },
    }),
    Prec.high(keymap.of([{ key: "Mod-Enter", run: (view) => openOrToggle(view, current, options) }])),
  ];
}
