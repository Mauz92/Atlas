/** Below the anchor, right edges aligned; flipped above or clamped when the viewport is short. */
export function placePopup(popup: HTMLElement, anchor: HTMLElement) {
  const margin = 8;
  const a = anchor.getBoundingClientRect();
  const m = popup.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = a.right - m.width;
  if (left < margin) left = a.left;
  left = Math.max(margin, Math.min(left, vw - m.width - margin));
  let top = a.bottom + 4;
  if (top + m.height > vh - margin && a.top - 4 - m.height >= margin) {
    top = a.top - 4 - m.height;
  }
  top = Math.max(margin, Math.min(top, vh - m.height - margin));
  popup.style.left = `${Math.round(left)}px`;
  popup.style.top = `${Math.round(top)}px`;
}
