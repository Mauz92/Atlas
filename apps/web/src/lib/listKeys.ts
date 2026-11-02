/**
 * List keyboard navigation (UX-03, ADR-0052): `j`/`k` move between task rows. A row is any
 * `.task-row`; the element focused in it is the one marked `data-row-focus` (its title button), so
 * Enter then opens the task. Rows are looked up in the page's `main` region (or the document), in
 * document order, so the keys walk across several lists on one page (Today's sections).
 */
export const ROW_SELECTOR = ".task-row";

function visibleRows(scope: ParentNode): HTMLElement[] {
  // Rows that are not rendered (inside a closed panel) are skipped; `hidden` covers that case.
  return [...scope.querySelectorAll<HTMLElement>(ROW_SELECTOR)].filter(
    (row) => !row.closest("[hidden], [inert]"),
  );
}

/** Focus a row's primary control (its title), or its first control when it has none. */
export function focusRow(row: HTMLElement | undefined): boolean {
  const target =
    row?.querySelector<HTMLElement>("[data-row-focus]") ??
    row?.querySelector<HTMLElement>("button, input");
  if (!target) return false;
  target.focus();
  target.scrollIntoView?.({ block: "nearest" });
  return true;
}

/** Move from the row holding `from` to the next (`1`) or previous (`-1`) row. */
export function moveRowFocus(from: HTMLElement, delta: 1 | -1): boolean {
  const row = from.closest<HTMLElement>(ROW_SELECTOR);
  const scope = from.closest("main") ?? document;
  const rows = visibleRows(scope);
  const at = row ? rows.indexOf(row) : -1;
  return focusRow(rows[at + delta]);
}

/** Focus the first (`j`) or last (`k`) row when focus is not in a row yet. */
export function focusEdgeRow(scope: ParentNode, edge: "first" | "last"): boolean {
  const rows = visibleRows(scope);
  return focusRow(edge === "first" ? rows[0] : rows[rows.length - 1]);
}

/** True when the element is inside a menu, a dialog or a row (the list keys do not apply there). */
export function inRowOrPopup(element: Element | null): boolean {
  return Boolean(element?.closest('[role="menu"], [role="dialog"], ' + ROW_SELECTOR));
}
