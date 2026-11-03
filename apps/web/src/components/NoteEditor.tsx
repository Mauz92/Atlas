import { useEffect, useImperativeHandle, useRef } from "react";
import type { Ref } from "react";

import {
  autocompletion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { Compartment, EditorState, type Extension, Transaction } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";

import type { NoteSummary } from "../api/client";
import {
  documentText,
  lineBreakOf,
  liveExtensions,
  refreshLive,
} from "../lib/livePreview";
import { resolveWikiLink, wikiCompletions } from "../lib/noteLinks";
import type { EditorMode } from "../lib/notesPrefs";

export interface NoteEditorHandle {
  /** The selected text, or the line the cursor is on when nothing is selected. */
  selectionOrLine: () => string;
  /** Put the cursor in the editor (after creating a note). */
  focus: () => void;
}

interface NoteEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** Notes offered after `[[` (MU-06). Read on each keystroke, so a changing list needs no rebuild. */
  notes?: readonly NoteSummary[];
  /** Put the cursor in the editor when it is created (a note was just made). */
  autoFocus?: boolean;
  /** Source shows the Markdown as typed; Live hides the syntax on lines without the cursor (UX-06). */
  mode?: EditorMode;
  /** A `[[link]]` to a note was activated in Live mode. */
  onOpenNote?: (id: string) => void;
  ref?: Ref<NoteEditorHandle>;
}

/**
 * `[[` completion: after `[[` the notes whose path or title match what was typed are offered, and
 * accepting one inserts its path (without `.md`) and the closing `]]` if absent. Only text is
 * inserted; the document stays ordinary Markdown.
 */
function wikiLinkSource(getNotes: () => readonly NoteSummary[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const before = context.matchBefore(/\[\[[^[\]\n|#^]*/);
    if (!before) {
      return null;
    }
    const typed = before.text.slice(2);
    return {
      from: before.from + 2,
      filter: false,
      options: wikiCompletions(getNotes(), typed).map(({ target, title }) => ({
        label: target,
        detail: title === target ? undefined : title,
        apply: (view, _completion, from, to) => {
          const closed = view.state.sliceDoc(to, to + 2) === "]]";
          const insert = closed ? target : `${target}]]`;
          view.dispatch({
            changes: { from, to, insert },
            selection: { anchor: from + target.length + 2 },
          });
        },
      })),
    };
  };
}

/**
 * Editor colours and type from the design tokens (UX-01), so the editor and the `[[` completion
 * popup follow light and dark mode through CSS variables, with no second theme to keep in sync.
 * The editor fills the height it is given and scrolls inside; the text is a centred column of at
 * most `--measure` (72ch), the way a note reads best (UX-05).
 */
const tokenTheme = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--text)",
    backgroundColor: "var(--bg)",
    fontSize: "var(--fs-base)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    lineHeight: "var(--lh-md)",
    overflow: "auto",
  },
  ".cm-content": {
    caretColor: "var(--text)",
    maxWidth: "var(--measure)",
    margin: "0 auto",
    padding: "var(--s-5) var(--s-4)",
  },
  ".cm-line": { padding: "0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--text)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    { backgroundColor: "var(--bg-selected)" },
  ".cm-activeLine": { backgroundColor: "transparent" },
  ".cm-gutters": {
    color: "var(--text-3)",
    backgroundColor: "var(--bg)",
    borderRight: "1px solid var(--border)",
  },
  ".cm-activeLineGutter": { backgroundColor: "var(--bg-hover)", color: "var(--text-2)" },
  ".cm-tooltip": {
    color: "var(--text)",
    backgroundColor: "var(--bg-raised)",
    border: "1px solid var(--border)",
    borderRadius: "var(--r-md)",
    boxShadow: "var(--shadow-2)",
  },
  ".cm-tooltip-autocomplete > ul > li": { padding: "var(--s-1) var(--s-2)" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
    color: "var(--text)",
    backgroundColor: "var(--bg-selected)",
  },
  ".cm-completionDetail": { color: "var(--text-3)" },
});

/** Markdown source editor (CodeMirror 6). The document is plain text — what you type is stored. */
export function NoteEditor({
  value,
  onChange,
  notes = [],
  autoFocus = false,
  mode = "source",
  onOpenNote,
  ref,
}: NoteEditorProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const changeHandler = useRef(onChange);
  changeHandler.current = onChange;
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const openNoteHandler = useRef(onOpenNote);
  openNoteHandler.current = onOpenNote;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const liveSlot = useRef(new Compartment());
  const live = useRef<Extension | null>(null);
  live.current ??= liveExtensions({
    resolveWiki: (raw) => {
      const { id, target } = resolveWikiLink(notesRef.current, raw);
      return { id, target };
    },
    openNote: (id) => openNoteHandler.current?.(id),
  });

  // The editor is created once with the text it is mounted with; later changes arrive via `value`.
  const initial = useRef(value);

  useImperativeHandle(ref, () => ({
    focus: () => view.current?.focus(),
    selectionOrLine: () => {
      const state = view.current?.state;
      if (!state) {
        return "";
      }
      const { from, to } = state.selection.main;
      return from === to ? state.doc.lineAt(from).text : state.sliceDoc(from, to);
    },
  }));

  /**
   * The editor state for a text. The line separator is the note's own (CRLF if it has any), so the
   * text that is saved is byte for byte the text that was loaded (AGENTS.md section 8). Live
   * preview sits in a compartment: switching mode reconfigures it without touching the document,
   * the selection or the undo history.
   */
  function createState(doc: string): EditorState {
    return EditorState.create({
      doc,
      extensions: [
        EditorState.lineSeparator.of(lineBreakOf(doc)),
        tokenTheme,
        EditorView.contentAttributes.of({ "aria-label": "Note content" }),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        markdown({ base: markdownLanguage }),
        autocompletion({ override: [wikiLinkSource(() => notesRef.current)], icons: false }),
        EditorView.lineWrapping,
        liveSlot.current.of(modeRef.current === "live" ? (live.current as Extension) : []),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            changeHandler.current(documentText(update.state));
          }
        }),
      ],
    });
  }

  useEffect(() => {
    if (!host.current) {
      return;
    }
    const instance = new EditorView({ state: createState(initial.current), parent: host.current });
    view.current = instance;
    if (autoFocus) {
      instance.focus();
    }
    return () => {
      instance.destroy();
      view.current = null;
    };
    // Created once per mount; `autoFocus` only matters at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const instance = view.current;
    if (!instance) {
      return;
    }
    const current = documentText(instance.state);
    if (current === value) {
      return;
    }
    if (lineBreakOf(value) !== instance.state.lineBreak) {
      // A different line ending cannot be reconfigured in place; this is an outside replacement
      // (reload of the server version), which is not undoable either.
      instance.setState(createState(value));
      return;
    }
    // Not part of the undo history: Ctrl+Z must never step back into another note's text.
    instance.dispatch({
      changes: { from: 0, to: instance.state.doc.length, insert: value },
      annotations: Transaction.addToHistory.of(false),
    });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({
      effects: liveSlot.current.reconfigure(mode === "live" ? (live.current as Extension) : []),
    });
  }, [mode]);

  useEffect(() => {
    if (mode === "live") {
      view.current?.dispatch({ effects: refreshLive.of(null) });
    }
    // Only the list of notes matters here: `[[links]]` are resolved against it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes]);

  return <div className="editor-host" data-testid="note-editor" ref={host} />;
}
