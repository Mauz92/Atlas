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
