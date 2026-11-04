import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
  });
}

const FORBIDDEN: [string, RegExp][] = [
  ["a DOM/browser global", /\b(window|document|localStorage|sessionStorage|indexedDB|navigator|location)\b/],
  ["a global fetch", /(^|[^.\w])fetch\s*\(/],
  ["React or a framework", /from\s+["'](react|react-dom|vue|svelte|@angular)/],
  ["a wall clock read", /\bDate\.now\b|new Date\s*\(\s*\)/],
  ["a global random source", /Math\.random|crypto\.randomUUID|getRandomValues/],
  ["a global timer", /\b(setTimeout|setInterval|setImmediate|requestAnimationFrame)\s*\(/],
  ["a Node-only module", /from\s+["']node:/],
];

describe("sync-core is framework-free", () => {
  const files = sources(join(import.meta.dirname));
  it("finds the sources", () => expect(files.length).toBeGreaterThan(10));
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
