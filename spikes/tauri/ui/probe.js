// Feature probe: what the existing Atlas web UI needs from the webview (found by grepping styles.css and src).
export function probe() {
  const css = (q) => { try { return CSS.supports(q); } catch { return "error"; } };
  const mm = (q) => matchMedia(q).matches;
  return {
    ua: navigator.userAgent,
    origin: location.origin,
    secureContext: window.isSecureContext,
    css: {
      has: css("selector(:has(*))"),
      dvh: css("height: 100dvh"),
      envSafeArea: css("padding-top: env(safe-area-inset-top)"),
      colorMix: css("color: color-mix(in srgb, red, blue)"),
      containerQueries: css("container-type: inline-size"),
      colorScheme: css("color-scheme: light dark"),
      focusVisible: css("selector(:focus-visible)"),
      popoverPseudo: css("selector(:popover-open)"),
      inset: css("inset: 0"),
      minMaxClamp: css("width: clamp(1px, 2vw, 3px)"),
      overscrollBehavior: css("overscroll-behavior: contain"),
      subgrid: css("grid-template-columns: subgrid"),
      lightDark: css("color: light-dark(red, blue)"),
    },
    media: { hoverNone: mm("(hover: none)"), pointerCoarse: mm("(pointer: coarse)"), dark: mm("(prefers-color-scheme: dark)"), reducedMotion: mm("(prefers-reduced-motion: reduce)") },
    api: {
      popoverAttr: "popover" in HTMLElement.prototype,
      showPopover: typeof HTMLElement.prototype.showPopover,
      inert: "inert" in HTMLElement.prototype,
      serviceWorker: "serviceWorker" in navigator,
      indexedDB: typeof indexedDB,
      localStorage: (() => { try { localStorage.setItem("p", "1"); localStorage.removeItem("p"); return true; } catch (e) { return String(e); } })(),
      randomUUID: typeof crypto?.randomUUID,
      subtle: typeof crypto?.subtle,
      Notification: typeof Notification === "undefined" ? "undefined" : Notification.permission,
      visualViewport: typeof visualViewport,
      clipboard: typeof navigator.clipboard,
      structuredClone: typeof structuredClone,
      dialogShowModal: typeof HTMLDialogElement?.prototype?.showModal,
      resizeObserver: typeof ResizeObserver,
      intl: typeof Intl.DateTimeFormat,
    },
  };
}
