import { changedLineCount, diffLines, splitLines } from "./diff";

describe("diffLines", () => {
  it("marks lines only in theirs as removed and only in mine as added", () => {
    const d = diffLines("a\nb\nc\n", "a\nB\nc\nd\n");
    expect(d).toEqual([
      { kind: "same", text: "a" },
      { kind: "removed", text: "b" },
      { kind: "added", text: "B" },
      { kind: "same", text: "c" },
      { kind: "added", text: "d" },
    ]);
    expect(changedLineCount(d)).toBe(3);
  });

  it("identical and empty texts", () => {
    expect(changedLineCount(diffLines("x\ny", "x\ny"))).toBe(0);
    expect(diffLines("", "")).toEqual([]);
    expect(diffLines("", "a")).toEqual([{ kind: "added", text: "a" }]);
  });

  it("reconstructs both texts from the diff", () => {
    const theirs = "one\ntwo\nthree\nfour\nfive";
    const mine = "one\n2\nthree\nfive\nsix";
    const d = diffLines(theirs, mine);
    expect(d.filter((l) => l.kind !== "added").map((l) => l.text)).toEqual(splitLines(theirs));
    expect(d.filter((l) => l.kind !== "removed").map((l) => l.text)).toEqual(splitLines(mine));
  });

  it("does not freeze on a very large difference", () => {
    const a = Array.from({ length: 3000 }, (_, i) => `a${i}`).join("\n");
    const b = Array.from({ length: 3000 }, (_, i) => `b${i}`).join("\n");
    expect(changedLineCount(diffLines(a, b))).toBe(6000);
  });
});
