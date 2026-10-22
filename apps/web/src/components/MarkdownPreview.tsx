import DOMPurify from "dompurify";
import { marked } from "marked";
import { useMemo } from "react";

marked.setOptions({ gfm: true, breaks: true });

/**
 * Renders Markdown to HTML and sanitises it before it reaches the DOM.
 * Note content is untrusted input (SECURITY.md T3/T6).
 */
export function MarkdownPreview({ content }: { content: string }) {
  const html = useMemo(() => {
    const rendered = marked.parse(content, { async: false });
    return DOMPurify.sanitize(typeof rendered === "string" ? rendered : "");
  }, [content]);

  return (
    <div
      className="markdown-preview"
      data-testid="markdown-preview"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
