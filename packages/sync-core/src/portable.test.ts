import { checkPortable, foldPath, normalizeNotePath } from "./portable.ts";

describe("portable paths", () => {
  it.each([
    ["CON.md", "reserved_name"],
    ["dir/aux.txt.md", "reserved_name"],
    ["a<b.md", "forbidden_character"],
    ["a /b.md", "trailing_dot_or_space"],
    ["x".repeat(300) + ".md", "too_long"],
    [`${"é".repeat(130)}.md`, "name_too_long"],
  ])("refuses %s", (path, reason) => {
    expect(checkPortable(path)?.reason).toBe(reason);
  });
  it("accepts an ordinary path", () => {
    expect(checkPortable("work/plan 2026.md")).toBeNull();
  });
  it("folds case and normalisation", () => {
    expect(foldPath("A.md")).toBe(foldPath("a.md"));
    expect(foldPath("é.md")).toBe(foldPath("é.md"));
  });
  it("adds the suffix and drops empty segments", () => {
    expect(normalizeNotePath("a//b")).toBe("a/b.md");
  });
});
