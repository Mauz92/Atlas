import type { NoteSummary } from "../api/client";

/** The folder that holds templates; the server only accepts notes from here (ADR-0049). */
export const TEMPLATES_FOLDER = "templates";

/** The path of the daily note for `date` (`YYYY-MM-DD`), the same one the server creates. */
export function dailyPath(date: string): string {
  return `daily/${date}.md`;
}

/** The notes that can be used as templates, in path order. */
export function templatesOf(notes: readonly NoteSummary[]): NoteSummary[] {
  return notes.filter((note) => note.path.startsWith(`${TEMPLATES_FOLDER}/`));
}

/**
 * A short plain-text preview of a note: the first few non-empty lines, without a leading level-1
 * heading (the note's title is shown separately). Never rendered as HTML.
 */
export function excerpt(content: string, maxLines = 6, maxChars = 400): string {
  const lines = content.split("\n").map((line) => line.trimEnd());
  while (lines.length > 0 && lines[0].trim() === "") {
    lines.shift();
  }
  if (lines[0]?.startsWith("# ")) {
    lines.shift();
  }
  const text = lines
    .filter((line) => line.trim() !== "")
    .slice(0, maxLines)
    .join("\n");
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/**
 * An excerpt as readable plain text (UX-09): Markdown markers a reader does not need are dropped
 * (`## Focus` becomes `Focus`, `- item` becomes `• item`, `- [ ]` / `- [x]` become ☐ / ☑). The
 * result is still plain text, rendered as text and never as HTML or Markdown (j6, SECURITY T3).
 */
export function plainPreview(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, "")
        .replace(/^(\s*)[-*+]\s+\[ \]\s+/, "$1☐ ")
        .replace(/^(\s*)[-*+]\s+\[[xX]\]\s+/, "$1☑ ")
        .replace(/^(\s*)[-*+]\s+/, "$1• "),
    )
    .join("\n");
}
