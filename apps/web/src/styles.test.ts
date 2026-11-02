import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Design-token contrast (UX-01, docs/UX_AUDIT.md §3.1 and §5). Reads the colour tokens straight
 * from styles.css for both themes and checks the WCAG 2.x contrast ratios the design relies on:
 * 4.5:1 for text (1.4.3), 3:1 for control outlines and focus indication (1.4.11).
 */
const css = readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");

type Tokens = Record<string, string>;

function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no "${selector}" block in styles.css`);
  const open = css.indexOf("{", start);
  return css.slice(open + 1, css.indexOf("}", open));
}

function tokens(body: string): Tokens {
  const found: Tokens = {};
  for (const match of body.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-f]{6})\s*;/gi)) {
    found[match[1]] = match[2].toLowerCase();
  }
  return found;
}

const light = tokens(block(":root"));
const systemDark = tokens(block(':root:not([data-theme="light"])'));
const explicitDark = tokens(block(':root[data-theme="dark"]'));

function luminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  const channels = [value >> 16, (value >> 8) & 255, value & 255].map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const SURFACES = ["--bg", "--bg-sidebar", "--bg-raised", "--bg-hover", "--bg-selected"];
const FIELD_SURFACES = ["--bg", "--bg-sidebar", "--bg-raised"];

/** [foreground, backgrounds, minimum ratio, why]. */
const REQUIREMENTS: [string, string[], number, string][] = [
  ["--text", SURFACES, 7, "body text (AAA)"],
  ["--text-2", SURFACES, 4.5, "secondary text"],
  ["--text-3", SURFACES, 4.5, "meta, placeholder, disabled text"],
  ["--border-control", FIELD_SURFACES, 3, "input/checkbox outline (1.4.11)"],
  ["--accent-text", SURFACES, 4.5, "links and focus ring"],
  ["--accent", ["--bg", "--bg-sidebar", "--bg-raised"], 3, "primary button / checked box vs page"],
  ["--accent-contrast", ["--accent", "--accent-hover"], 4.5, "text on the primary button"],
  ["--danger", [...SURFACES, "--danger-soft"], 4.5, "danger text and pill"],
  ["--warning", [...SURFACES, "--warning-soft"], 4.5, "overdue/high priority text and pill"],
  ["--success", [...SURFACES, "--success-soft"], 4.5, "success text and pill"],
];

describe.each([
  ["light", light],
  ["dark", explicitDark],
])("%s theme tokens", (_name, theme) => {
  it("defines every token the checks need", () => {
    for (const [fg, bgs] of REQUIREMENTS) {
      for (const name of [fg, ...bgs]) {
        expect(theme[name], name).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it.each(REQUIREMENTS)("%s meets its ratio on %j (≥ %d:1, %s)", (fg, bgs, minimum) => {
    for (const bg of bgs) {
      const ratio = contrast(theme[fg], theme[bg]);
      expect(ratio, `${fg} ${theme[fg]} on ${bg} ${theme[bg]} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(
        minimum,
      );
    }
  });

  it("keeps region dividers subtle (they are not control boundaries)", () => {
    expect(contrast(theme["--border"], theme["--bg"])).toBeLessThan(1.6);
  });
});

describe("dark mode definitions", () => {
  it("System dark (prefers-color-scheme) and explicit Dark are identical", () => {
    expect(Object.keys(systemDark).length).toBeGreaterThan(20);
    expect(systemDark).toEqual(explicitDark);
  });

  it("sits inside a prefers-color-scheme media query that yields to an explicit Light choice", () => {
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\)\s*{\s*:root:not\(\[data-theme="light"\]\)\s*{/);
  });

  it("redefines every colour token of the light theme", () => {
    expect(Object.keys(explicitDark).sort()).toEqual(Object.keys(light).sort());
  });
});

describe("contrast()", () => {
  it("matches known WCAG values", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    expect(contrast("#767676", "#ffffff")).toBeCloseTo(4.54, 2);
  });
});
