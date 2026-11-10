import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "testing" ? [] : sources(path);
    return path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
  });
}

// The platform boundary (ADR-0069): nothing in the core may name a host. If it does, the Electron fallback gets harder.
const FORBIDDEN: [string, RegExp][] = [
  ["a DOM/browser global", /\b(window|document|localStorage|sessionStorage|indexedDB|navigator|location)\b/],
  ["a global fetch", /(^|[^.\w])fetch\s*\(/],
  ["Tauri, React or another framework", /from\s+["'](react|react-dom|vue|svelte|@angular|@tauri-apps|electron)/],
  ["__TAURI__", /__TAURI/],
  ["a wall clock read", /\bDate\.now\b|new Date\s*\(\s*\)/],
  ["a global random source", /Math\.random|crypto\.randomUUID|getRandomValues/],
  ["a global timer", /(^|[^.\w])(setTimeout|setInterval|clearTimeout|clearInterval|setImmediate)\s*\((?!fn:)/],
  ["a Node-only module", /from\s+["']node:/],
];

describe("desktop-core is framework-neutral", () => {
  const files = sources(join(import.meta.dirname));
  it("finds the sources", () => expect(files.length).toBeGreaterThan(8));
  for (const [what, pattern] of FORBIDDEN) {
    it(`uses no ${what}`, () => {
      const hits = files.filter((file) => {
        const code = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
        return pattern.test(code);
      });
      expect(hits).toEqual([]);
    });
  }
});
