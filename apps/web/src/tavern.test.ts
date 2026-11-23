import { readFileSync } from "node:fs";
import path from "node:path";

const css = readFileSync(path.join(__dirname, "tavern.css"), "utf8");

/** The `--token: value;` pairs inside the block that starts at `selector`. */
function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  const out: Record<string, string> = {};
  for (const match of css.slice(open + 1, close).matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) out[match[1]] = match[2].trim();
  return out;
}

function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}
function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const light = tokens(':root[data-palette="tavern"] {');
const systemDark = tokens(':root[data-palette="tavern"]:not([data-theme="light"]) {');
const explicitDark = tokens(':root[data-palette="tavern"][data-theme="dark"] {');
const colourKeys = (t: Record<string, string>) => Object.keys(t).filter((k) => /^#/.test(t[k]));

describe("Tavern palette", () => {
  it("has identical System-dark and explicit Dark values", () => {
    expect(systemDark).toEqual(explicitDark);
    expect(Object.keys(systemDark).length).toBeGreaterThan(20);
  });

  it("defines the same colour tokens for light and dark", () => {
    expect(colourKeys(light).sort()).toEqual(colourKeys(systemDark).sort());
  });

  for (const [name, set] of [["light", light], ["dark", systemDark]] as const) {
    it(`keeps text and controls readable in ${name}`, () => {
      for (const surface of ["--bg", "--bg-sidebar", "--bg-raised", "--bg-page", "--bg-card", "--bg-section"]) {
        for (const text of ["--text", "--text-2", "--text-3", "--accent-text", "--danger", "--warning", "--success", "--due-today"]) {
          expect(ratio(set[text], set[surface]), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
        }
      }
      expect(ratio(set["--accent-contrast"], set["--accent"]), "accent button text").toBeGreaterThanOrEqual(4.5);
      expect(ratio(set["--border-control"], set["--bg"]), "control border").toBeGreaterThanOrEqual(3);
    });
  }
});
