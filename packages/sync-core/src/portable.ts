/**
 * Portable note paths (the client twin of `atlas/notes/portable.py`, SYNC_PROTOCOL 11).
 *
 * A client skips a local path the server would refuse (`422 invalid_path`) instead of sending it,
 * and the model server in the simulation applies the same rules.
 */

const FORBIDDEN = new Set([...'<>:"|?*']);
const RESERVED = new Set<string>([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "CONIN$",
  "CONOUT$",
  ...["COM", "LPT"].flatMap((p) => [..."0123456789¹²³"].map((d) => `${p}${d}`)),
]);
export const MAX_PATH_CHARS = 240;
export const MAX_SEGMENT_BYTES = 255;

export type PortableReason =
  | "too_long"
  | "name_too_long"
  | "forbidden_character"
  | "trailing_dot_or_space"
  | "reserved_name";

export interface PortableProblem {
  reason: PortableReason;
  detail: string;
}

const encoder = new TextEncoder();

/** `null` when `path` (normalised, relative, `/`-separated) works on every supported platform. */
export function checkPortable(path: string): PortableProblem | null {
  if ([...path].length > MAX_PATH_CHARS)
    return { reason: "too_long", detail: `a path may have at most ${MAX_PATH_CHARS} characters` };
  for (const segment of path.split("/")) {
    if (encoder.encode(segment).length > MAX_SEGMENT_BYTES)
      return {
        reason: "name_too_long",
        detail: `a file or folder name may have at most ${MAX_SEGMENT_BYTES} bytes`,
      };
    for (const ch of segment) {
      const code = ch.codePointAt(0)!;
      if (FORBIDDEN.has(ch) || code < 32 || code === 127)
        return { reason: "forbidden_character", detail: "a name contains a forbidden character" };
    }
    if (segment.endsWith(".") || segment.endsWith(" "))
      return {
        reason: "trailing_dot_or_space",
        detail: "a name may not end with a dot or a space",
      };
    const stem = segment.split(".", 1)[0]!.replace(/ +$/, "").toUpperCase();
    if (RESERVED.has(stem))
      return { reason: "reserved_name", detail: `${stem} is a reserved name on Windows` };
  }
  return null;
}

/** The comparison key of a path on a case-insensitive, normalising file system. */
export function foldPath(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

/** Server-side `normalize_note_path`, enough for the simulation: relative, `.md` suffix. */
export function normalizeNotePath(path: string): string {
  const parts = path
    .replace(/\\/g, "/")
    .split("/")
    .filter((p) => p !== "" && p !== ".");
  const joined = parts.join("/");
  return joined.endsWith(".md") ? joined : `${joined}.md`;
}
