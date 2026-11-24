import { readFileSync } from "node:fs";
import path from "node:path";

/** The TTRPG light theme must keep its warning colour readable on the tinted condition chip (a real-stack axe check caught 4.0:1). */
const css = readFileSync(path.join(__dirname, "ttrpg.css"), "utf8");

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const lum = (c: number[]) => 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
const ratio = (a: number[], b: number[]) => {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const mix = (a: number[], b: number[], p: number) => a.map((v, i) => Math.round(v * p + b[i] * (1 - p)));

describe("TTRPG light theme", () => {
  it("keeps the warning colour at 4.5:1 on the condition chip over every light surface", () => {
    const warns = [...css.matchAll(/--tt-warn: (#[0-9a-f]{6})/gi)].map((m) => m[1]);
    const light = warns.slice(1); // the first is the dark default
    expect(light.length).toBe(2); // the system-light block and the explicit light block
    for (const warn of light) {
      for (const surface of ["#f6ecd0", "#efe2bf", "#e9dcb9"]) {
        const chip = mix(rgb(warn), rgb(surface), 0.1); // .tt-chip tints itself 10% with the warning colour
        expect(ratio(rgb(warn), chip), `${warn} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
