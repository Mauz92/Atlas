/**
 * The phone breakpoints in one place (UX-10, ADR-0063). They match the CSS: `NARROW` in Layout.tsx
 * and the `@media (max-width: 720px)` blocks of styles.css.
 */

/** A phone-width window: bottom nav, FAB, no rail. */
export const PHONE_QUERY = "(max-width: 720px)";

/**
 * Menus and small dialogs become bottom sheets on phones and on any device with no hover (a
 * tablet): a popover anchored at a 44 px "..." is too small to hit and covers the row text.
 */
export const SHEET_QUERY = "(max-width: 720px), (hover: none)";

/** Promote an element to the browser's top layer (native Popover API) where it is supported. */
export function promoteToTopLayer(element: HTMLElement | null) {
  if (!element || typeof element.showPopover !== "function") return;
  if (!element.hasAttribute("popover")) element.setAttribute("popover", "manual");
  try {
    element.showPopover();
  } catch {
    // Already shown, or not connected yet: the fixed position and z-index in the CSS still apply.
  }
}
