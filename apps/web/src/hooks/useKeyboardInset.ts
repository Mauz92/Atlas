import { useEffect, useState } from "react";

import { keyboardInset } from "../lib/keyboardInset";

/**
 * The height the on-screen keyboard covers at the bottom of the window (0 when there is no
 * `visualViewport`, as in jsdom and old browsers). Updates on every visual-viewport resize or scroll.
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(() =>
    typeof window === "undefined" ? 0 : keyboardInset(window.innerHeight, window.visualViewport),
  );
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => setInset(keyboardInset(window.innerHeight, window.visualViewport));
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);
  return inset;
}
