/**
 * A project's identity colour (UX-09, ADR-0062). It is derived, not stored: `hash(id) % 8` picks one
 * of the eight `--project-N` tokens in styles.css, so the colour is stable across devices and
 * sessions and needs no schema, API or sync change. A user-chosen colour would be a later,
 * separate decision. The colour is a dot next to the project's name; it never stands alone.
 */
export const PROJECT_HUES = 8;

/** FNV-1a (32-bit) over the UTF-16 code units of `id`; deterministic and well spread for UUIDs. */
function fnv1a(id: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** The hue number (1..8) of a project id, i.e. the `N` of `--project-N`. */
export function projectHue(id: string): number {
  return (fnv1a(id) % PROJECT_HUES) + 1;
}
