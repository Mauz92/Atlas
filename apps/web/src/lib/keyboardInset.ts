/**
 * How far the on-screen keyboard (or any overlay that shrinks only the *visual* viewport) covers
 * the bottom of the layout viewport, in px (UX-10, ADR-0063).
 *
 * iOS Safari keeps the layout viewport at full height and shrinks `visualViewport`, so a fixed bottom
 * sheet would sit behind the keyboard; the sheet lifts itself by this amount. Chromium on Android with
 * `interactive-widget=resizes-content` shrinks the layout viewport instead, so `innerHeight` already
 * equals the visual height and the result is 0 (no double correction).
 */
export function keyboardInset(
  innerHeight: number,
  viewport: { height: number; offsetTop: number } | null | undefined,
): number {
  if (!viewport) return 0;
  const inset = innerHeight - viewport.height - viewport.offsetTop;
  return Number.isFinite(inset) && inset > 0 ? Math.round(inset) : 0;
}
