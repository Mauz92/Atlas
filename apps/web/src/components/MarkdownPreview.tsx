import DOMPurify from "dompurify";
import { marked } from "marked";
import { useMemo } from "react";

marked.setOptions({ gfm: true, breaks: true });

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
export function MarkdownPreview({ content }: { content: string }) {
  const html = useMemo(() => {
    const rendered = marked.parse(content, { async: false });
    const safe = DOMPurify.sanitize(typeof rendered === "string" ? rendered : "", {
      RETURN_DOM_FRAGMENT: true,
    });
    labelTaskCheckboxes(safe);
    const container = document.createElement("div");
    container.appendChild(safe);
    return container.innerHTML;
  }, [content]);

  return (
    <div
      className="markdown-preview"
      data-testid="markdown-preview"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
