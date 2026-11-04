// Embedded-UI smoke (suite "embedded"): the existing web bundle served from tauri://localhost. Collects errors and facts, reports after 5 s.
(function () {
  const errors = [];
  addEventListener("error", (e) => errors.push("error: " + e.message));
  addEventListener("unhandledrejection", (e) => errors.push("rejection: " + String(e.reason).slice(0, 200)));
  const ce = console.error; console.error = (...a) => { errors.push("console.error: " + a.map(String).join(" ").slice(0, 200)); ce.apply(console, a); };
  addEventListener("load", () => setTimeout(async () => {
    const inv = window.__TAURI_INTERNALS__.invoke;
    await inv("report", { name: "embedded-ui", value: { origin: location.origin, title: document.title, text: document.body.innerText.slice(0, 300), rootChildren: document.getElementById("root")?.children.length, errors, scripts: [...document.scripts].map((s) => s.src), sw: "serviceWorker" in navigator } });
  }, 4000));
})();
