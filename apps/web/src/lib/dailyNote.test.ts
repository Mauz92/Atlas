import { dailyPath, excerpt, templatesOf } from "./dailyNote";

describe("dailyNote helpers", () => {
  it("builds the daily path", () => {
    expect(dailyPath("2026-11-02")).toBe("daily/2026-11-02.md");
  });

  it("offers only notes inside templates/", () => {
    const notes = [
      "templates/a.md",
      "a/templates/b.md",
      "templates.md",
      "templates/x/y.md",
    ].map((path) => ({ path }) as never);
    expect(templatesOf(notes).map((note) => note.path)).toEqual([
      "templates/a.md",
      "templates/x/y.md",
    ]);
  });

  it.each([
    ["# 2026-11-02\n\n\nfirst\n\nsecond\n", "first\nsecond"],
    ["no heading\nsecond", "no heading\nsecond"],
    ["## Plan\nx", "## Plan\nx"],
    ["", ""],
    ["a\nb\nc\nd", "a\nb"],
  ])("excerpt(%j)", (input, expected) => {
    expect(excerpt(input, 2)).toBe(expected);
  });

  it("truncates long previews", () => {
    expect(excerpt("x".repeat(50), 6, 10)).toBe(`${"x".repeat(10)}…`);
  });
});
