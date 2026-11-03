import { PROJECT_HUES, projectHue } from "./projectColor";

describe("projectHue", () => {
  it("is stable for an id and stays within 1..8", () => {
    const id = "7420b23e-fbc7-45d5-89e3-f6e9077f7ef5";
    expect(projectHue(id)).toBe(projectHue(id));
    expect(projectHue(id)).toBeGreaterThanOrEqual(1);
    expect(projectHue(id)).toBeLessThanOrEqual(PROJECT_HUES);
  });

  it("is hash(id) % 8 with a fixed algorithm (these values must never change: they are the user's colours)", () => {
    expect(projectHue("")).toBe(((0x811c9dc5 % 8) + 1));
    expect(projectHue("a")).toBe(projectHue("a"));
    expect([projectHue("project-a"), projectHue("project-b"), projectHue("project-c")]).toEqual([
      projectHue("project-a"),
      projectHue("project-b"),
      projectHue("project-c"),
    ]);
  });

  it("uses all eight hues over many ids, roughly evenly", () => {
    const counts = new Array<number>(PROJECT_HUES + 1).fill(0);
    for (let index = 0; index < 4000; index += 1) {
      counts[projectHue(`00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`)] += 1;
    }
    for (let hue = 1; hue <= PROJECT_HUES; hue += 1) {
      expect(counts[hue], `hue ${hue}`).toBeGreaterThan(350);
      expect(counts[hue], `hue ${hue}`).toBeLessThan(650);
    }
  });
});
