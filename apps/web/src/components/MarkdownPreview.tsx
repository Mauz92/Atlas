import DOMPurify from "dompurify";
import { Marked } from "marked";
import { useMemo } from "react";
import type { MouseEvent } from "react";

import type { NoteSummary } from "../api/client";
import { resolveWikiLink } from "../lib/noteLinks";

const NO_NOTES: readonly Pick<NoteSummary, "id" | "path">[] = [];

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * `[[target]]` and `[[target|label]]` become links to the note (UX-05). An unresolved target shows
 * as plain text that says so. Everything written into the HTML is escaped here, and the result is
 * sanitised again below like all other note content.
 */
function markdownFor(notes: readonly Pick<NoteSummary, "id" | "path">[]): Marked {
  return new Marked({ gfm: true, breaks: true }).use({
    extensions: [
      {
        name: "wikilink",
        level: "inline",
        start: (src: string) => src.indexOf("[["),
        tokenizer(src: string) {
          const match = /^\[\[([^[\]\n]+?)\]\]/.exec(src);
          return match ? { type: "wikilink", raw: match[0], text: match[1] } : undefined;
        },
        renderer(token) {
          const { id, target, label } = resolveWikiLink(notes, String((token as { text?: string }).text));
          return id
            ? `<a class="wikilink" href="/notes?open=${encodeURIComponent(id)}" data-note-id="${escapeHtml(id)}">${escapeHtml(label)}</a>`
            : `<span class="wikilink unresolved" title="${escapeHtml(`No note “${target}” yet`)}">${escapeHtml(label)}</span>`;
        },
      },
    ],
  });
}

/**
 * A Markdown task item (`- [ ] text`) renders as a disabled checkbox with no label; name it after
 * its item's text so assistive technology can tell the boxes apart (axe `label`, UX-01). Runs on
 * the already-sanitised fragment and only sets an attribute value, so no markup is introduced.
 */
function labelTaskCheckboxes(fragment: DocumentFragment) {
  fragment.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((box) => {
    const text = box.closest("li")?.textContent?.trim();
    box.setAttribute("aria-label", text ? text : "Task item");
  });
}

/**
 * Renders Markdown to HTML and sanitises it before it reaches the DOM.
 * Note content is untrusted input (SECURITY.md T3/T6).
 */
export function MarkdownPreview({
  content,
  notes = NO_NOTES,
  onOpenNote,
  onNavigate,
}: {
  content: string;
  /** Notes `[[links]]` are resolved against. */
  notes?: readonly Pick<NoteSummary, "id" | "path">[];
  /** A `[[link]]` to a note was activated; without it the link navigates normally. */
  onOpenNote?: (id: string) => void;
  /** An in-app link (`/ttrpg/...`, e.g. an encounter launch link) was activated; without it the link navigates normally. */
  onNavigate?: (path: string) => void;
}) {
  const markdown = useMemo(() => markdownFor(notes), [notes]);
  const html = useMemo(() => {
    const rendered = markdown.parse(content, { async: false });
    const safe = DOMPurify.sanitize(typeof rendered === "string" ? rendered : "", {
      RETURN_DOM_FRAGMENT: true,
    });
    labelTaskCheckboxes(safe);
    const container = document.createElement("div");
    container.appendChild(safe);
    return container.innerHTML;
  }, [markdown, content]);

  return (
    <div
      className="markdown-preview"
      data-testid="markdown-preview"
      onClick={(event: MouseEvent<HTMLDivElement>) => {
        const link = (event.target as HTMLElement).closest<HTMLElement>("a[data-note-id]");
        const plain = !event.metaKey && !event.ctrlKey && !event.shiftKey && event.button === 0;
        if (link?.dataset.noteId && onOpenNote && plain) {
          event.preventDefault();
          onOpenNote(link.dataset.noteId);
          return;
        }
        const app = (event.target as HTMLElement).closest<HTMLAnchorElement>("a[href]");
        const href = app?.getAttribute("href") ?? "";
        if (onNavigate && plain && /^\/ttrpg\/[A-Za-z0-9/_-]*$/.test(href)) {
          event.preventDefault();
          onNavigate(href);
        }
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
