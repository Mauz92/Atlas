#!/usr/bin/env node
/**
 * Design-scale check (UX-01, docs/UX_AUDIT.md §3.2). Fails when a `font-size`, `gap` or `padding`
 * declaration in the app stylesheet uses anything but a scale token: `var(--fs-*)` for font-size,
 * `var(--s-*)` for gap/padding, or `0` / `inherit`. Run by `npm run lint` (and so by
 * scripts/verify.sh). Usage: node scripts/check-css-scale.mjs [file.css ...]
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [path.join(here, "..", "src", "styles.css")];

const RULES = [
  { property: /^font-size$/, token: /^var\(--fs-(xs|sm|base|md|lg|xl|2xl)\)$/ },
  {
    property: /^(gap|row-gap|column-gap|padding(-(top|right|bottom|left|inline|block)(-(start|end))?)?)$/,
    token: /^var\(--s-[1-7]\)$/,
  },
];
const ALWAYS_ALLOWED = /^(0|inherit)$/;

/** Every `property: value` declaration with its line number, ignoring comments. */
export function declarations(css) {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  const found = [];
  const pattern = /(^|[;{\s])([a-z-]+)\s*:\s*([^;{}]+?)\s*(?=[;}])/g;
  let match;
  while ((match = pattern.exec(stripped)) !== null) {
    const line = stripped.slice(0, match.index + match[1].length).split("\n").length;
    found.push({ property: match[2], value: match[3].replace(/\s*!important$/, ""), line });
  }
  return found;
}

/** The declarations that break the scale rules. */
export function violations(css) {
  const bad = [];
  for (const { property, value, line } of declarations(css)) {
    const rule = RULES.find((candidate) => candidate.property.test(property));
    if (!rule) continue;
    const parts = value.split(/\s+/);
    if (!parts.every((part) => ALWAYS_ALLOWED.test(part) || rule.token.test(part))) {
      bad.push({ property, value, line });
    }
  }
  return bad;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let failed = 0;
  for (const file of files) {
    for (const { property, value, line } of violations(readFileSync(file, "utf8"))) {
      console.error(`${path.relative(process.cwd(), file)}:${line}: ${property}: ${value} is not a scale value`);
      failed += 1;
    }
  }
  if (failed > 0) {
    console.error(`check-css-scale: ${failed} declaration(s) off the type/space scale (see docs/UX_AUDIT.md §3.2)`);
    process.exit(1);
  }
  console.log(`check-css-scale: OK (${files.length} file(s))`);
}
