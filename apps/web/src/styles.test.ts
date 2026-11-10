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

/** Surfaces added by UX-09 (ADR-0062): the page tint, the section card and the header band. */
const LIST_SURFACES = ["--bg-page", "--bg-card", "--bg-section"];
const ROW_SURFACES = [...SURFACES, ...LIST_SURFACES];
const PROJECT_DOTS = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `--project-${n}`);
const DOT_SURFACES = [...FIELD_SURFACES, ...LIST_SURFACES, "--bg-hover", "--bg-selected"];

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
  // UX-09: text on the new list surfaces and the due/priority/project colours used in rows.
  ["--text", LIST_SURFACES, 7, "body text on the page tint, card and header band"],
  ["--text-2", LIST_SURFACES, 4.5, "header band text and project names on the new surfaces"],
  ["--text-3", ["--bg-page", "--bg-card"], 4.5, "tags and meta on the page tint and card"],
  ["--due-overdue", [...ROW_SURFACES, "--due-overdue-soft"], 4.5, "overdue chip and header text"],
  ["--due-today", [...ROW_SURFACES, "--due-today-soft"], 4.5, "due-today chip and header text"],
  ["--priority-urgent", ROW_SURFACES, 4.5, "urgent flag text"],
  ["--priority-high", ROW_SURFACES, 4.5, "high flag text"],
  ...PROJECT_DOTS.map((dot): [string, string[], number, string] => [dot, DOT_SURFACES, 3, "project dot (1.4.11)"]),
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

  it("keeps the new surfaces and the row hairline distinct but calm", () => {
    // A card is told from the page by its outline, so the outline must be visible and the fill
    // difference subtle; the hairline is decorative (not a control boundary).
    expect(contrast(theme["--border-strong"], theme["--bg-page"])).toBeGreaterThanOrEqual(1.25);
    expect(contrast(theme["--bg-card"], theme["--bg-page"])).toBeLessThan(1.2);
    expect(contrast(theme["--row-sep"], theme["--bg-card"])).toBeGreaterThanOrEqual(1.2);
    expect(contrast(theme["--row-sep"], theme["--bg-card"])).toBeLessThan(1.6);
  });

  it("keeps overdue, today and the priorities apart, and the eight project hues distinct", () => {
    expect(theme["--due-overdue"]).not.toBe(theme["--due-today"]);
    expect(theme["--priority-high"]).not.toBe(theme["--due-overdue"]);
    expect(new Set(PROJECT_DOTS.map((name) => theme[name])).size).toBe(8);
  });

  it("keeps region dividers subtle (they are not control boundaries)", () => {
    expect(contrast(theme["--border"], theme["--bg"])).toBeLessThan(1.6);
  });
});

/**
 * Accent colours (UX-12, ADR-0073). Every accent is checked in Light and Dark against every surface it
 * can appear on. Neutral is the base tokens (no data-accent). An accent block may define only the five
 * accent tokens, so overdue, due-today, priority, success, warning, danger, project and calendar colours
 * cannot follow it.
 */
const ACCENT_IDS = ["blue", "indigo", "violet", "pink", "red", "orange", "amber", "green", "teal"];
const ACCENT_TOKENS = ["--accent", "--accent-hover", "--accent-contrast", "--accent-text", "--accent-soft"];
const ALL_SURFACES = [...SURFACES, ...LIST_SURFACES];
const atlasHeadingSurfaces = ["--bg", "--bg-page", "--bg-card", "--bg-section", "--bg-sidebar", "--bg-raised"];

const accentLight = (id: string) => tokens(block(`:root[data-accent="${id}"]`));
const accentSystemDark = (id: string) => tokens(block(`:root[data-accent="${id}"]:not([data-theme="light"])`));
const accentExplicitDark = (id: string) => tokens(block(`:root[data-theme="dark"][data-accent="${id}"]`));

const ACCENT_THEMES: [string, string, Tokens][] = [
  ["neutral", "light", light],
  ["neutral", "dark", explicitDark],
  ...ACCENT_IDS.flatMap((id): [string, string, Tokens][] => [
    [id, "light", { ...light, ...accentLight(id) }],
    [id, "dark", { ...explicitDark, ...accentExplicitDark(id) }],
  ]),
];

describe.each(ACCENT_THEMES)("accent %s, %s theme", (_id, _theme, t) => {
  const ratio = (fg: string, bg: string) => contrast(t[fg], t[bg]);
  const atLeast = (fg: string, bgs: string[], minimum: number) => {
    for (const bg of bgs) {
      expect(ratio(fg, bg), `${fg} ${t[fg]} on ${bg} ${t[bg]} = ${ratio(fg, bg).toFixed(2)}`).toBeGreaterThanOrEqual(
        minimum,
      );
    }
  };

  it("text in the accent (links, selected labels, tags) reads on every surface and on the tint (4.5:1)", () => {
    atLeast("--accent-text", [...ALL_SURFACES, "--accent-soft"], 4.5);
  });

  it("the solid accent (button, checked box, progress, tab underline, selected outline) is 3:1 on every surface", () => {
    atLeast("--accent", ALL_SURFACES, 3);
    atLeast("--accent-hover", ALL_SURFACES, 3);
  });

  it("text on the solid accent and its hover is 4.5:1", () => {
    atLeast("--accent-contrast", ["--accent", "--accent-hover"], 4.5);
  });

  it("heading text (accent-text) is 4.5:1 on every surface a heading sits on: page, card, section band, sidebar, raised panel, editor", () => {
    // Large-text 3:1 is deliberately not used as the bar. The editor background is --bg.
    atlasHeadingSurfaces.forEach((surface) => atLeast("--accent-text", [surface], 4.5));
  });

  it("the focus ring (accent-text) is 3:1 on every surface and the tint", () => {
    atLeast("--accent-text", [...ALL_SURFACES, "--accent-soft"], 3);
    // A focused primary button is outlined with the ring against the page, not against itself.
    expect(ratio("--accent-text", "--bg")).toBeGreaterThanOrEqual(3);
  });

  it("body and secondary text stay readable on the tint used for selected rows and tabs", () => {
    atLeast("--text", ["--accent-soft"], 7);
    atLeast("--text-2", ["--accent-soft"], 4.5);
    atLeast("--text-3", ["--accent-soft"], 4.5);
  });

  it("the tint is a calm fill: close to the page, never a second page colour", () => {
    expect(ratio("--accent-soft", "--bg")).toBeLessThan(1.4);
  });

  it("keeps the semantic colours readable on the tint (a tag or chip may sit on it)", () => {
    atLeast("--danger", ["--accent-soft"], 4.5);
    atLeast("--warning", ["--accent-soft"], 4.5);
    atLeast("--success", ["--accent-soft"], 4.5);
  });
});

describe("accent definitions", () => {
  it.each(ACCENT_IDS)("%s defines exactly the accent tokens, identically for System dark and Dark", (id) => {
    expect(Object.keys(accentLight(id)).sort()).toEqual([...ACCENT_TOKENS].sort());
    expect(Object.keys(accentExplicitDark(id)).sort()).toEqual([...ACCENT_TOKENS].sort());
    expect(accentSystemDark(id)).toEqual(accentExplicitDark(id));
  });

  it("the System-dark accent blocks are inside the prefers-color-scheme query and more specific than the light ones", () => {
    const query = css.indexOf("@media (prefers-color-scheme: dark)", css.indexOf(':root[data-accent="blue"] {'));
    expect(query).toBeGreaterThan(0);
    expect(css.indexOf(':root[data-accent="blue"]:not([data-theme="light"]) {')).toBeGreaterThan(query);
  });

  it("every accent differs from the others and from Neutral in each theme", () => {
    for (const theme of [accentLight, accentExplicitDark]) {
      const accents = ACCENT_IDS.map((id) => theme(id)["--accent"]);
      expect(new Set([...accents, theme === accentLight ? light["--accent"] : explicitDark["--accent"]]).size).toBe(
        ACCENT_IDS.length + 1,
      );
    }
  });

  it("picker sample colours exist for every accent and are 3:1 on the card and panel in both themes", () => {
    for (const id of [...ACCENT_IDS, "neutral"]) {
      const match = css.match(new RegExp(`--swatch-${id}:\\s*(#[0-9a-f]{6});`, "i"));
      expect(match, `--swatch-${id}`).not.toBeNull();
      const swatch = match![1].toLowerCase();
      for (const theme of [light, explicitDark]) {
        for (const surface of ["--bg-raised", "--bg-card", "--bg"]) {
          expect(contrast(swatch, theme[surface]), `${id} ${swatch} on ${surface}`).toBeGreaterThanOrEqual(3);
        }
      }
    }
  });

  it("coloured headings use only --accent-text, only under data-accent-text=on, and never the semantic or body selectors", () => {
    const start = css.indexOf(':root[data-accent-text="on"] h1,');
    expect(start).toBeGreaterThan(0);
    const open = css.indexOf("{", start);
    const selectors = css.slice(start, open).split(",").map((part) => part.trim());
    expect(css.slice(open + 1, css.indexOf("}", open)).trim()).toBe("color: var(--accent-text);");
    for (const selector of selectors) expect(selector.startsWith(':root[data-accent-text="on"] ')).toBe(true);
    const joined = selectors.join(" ");
    for (const forbidden of [".section-head", ".task-row", ".task-title", "label", ".muted", ".hint", ".due", "overdue", "priority", ".week-day", ".cal-agenda-day", "body", " p"]) {
      expect(joined, forbidden).not.toContain(forbidden);
    }
    // Neutral never sets the attribute (see accent.test.ts), and its --accent-text equals --text anyway.
    expect(light["--accent-text"]).toBe(light["--text"]);
    expect(explicitDark["--accent-text"]).toBe(explicitDark["--text"]);
  });

  it("styles.css has no colour literal outside the token blocks (colours only through tokens)", () => {
    const base = css.indexOf("/* --- Base ---");
    expect(base).toBeGreaterThan(0);
    const rest = css.slice(base).replace(/\/\*[\s\S]*?\*\//g, "");
    // The accent picker's dots use var(--swatch-*) only; rgb()/hex/hsl() belong in the token blocks.
    expect(rest.match(/#[0-9a-fA-F]{3,8}\b|\bhsla?\(/g) ?? []).toEqual([]);
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

describe("phone and touch rules (UX-10)", () => {
  const html = readFileSync(path.join(process.cwd(), "index.html"), "utf8");

  it("covers the notch area and resizes with the keyboard, so safe-area insets apply", () => {
    expect(html).toMatch(/<meta name="viewport"[^>]*viewport-fit=cover/);
    expect(html).toMatch(/<meta name="viewport"[^>]*interactive-widget=resizes-content/);
    for (const edge of ["top", "right", "bottom", "left"]) {
      expect(css).toContain(`env(safe-area-inset-${edge}, 0px)`);
    }
  });

  it("sets 16px text fields on phones and touch (no iOS zoom on focus)", () => {
    expect(css).toMatch(
      /@media \(pointer: coarse\), \(hover: none\), \(max-width: 720px\) {\s*input:not\(\[type="checkbox"\]\)[^{]*{\s*font-size: var\(--fs-md\);/,
    );
    expect(css).toMatch(/--fs-md: 16px;/);
  });

  it("pads the bottom nav, FAB and sheets for the home indicator without new colours", () => {
    expect(css).toMatch(/\.bottom-nav {\s*height: calc\(var\(--bottom-nav\) \+ var\(--safe-bottom\)\)/);
    expect(css).toMatch(/\.capture-fab {[^}]*bottom: calc\(var\(--bottom-clear\) \+ var\(--s-4\)\)/);
    expect(css).toMatch(/\.sheet::after {[^}]*height: var\(--safe-bottom\)/);
    expect(css).toMatch(/\.menu\.is-sheet::after {[^}]*height: var\(--safe-bottom\)/);
  });
});
