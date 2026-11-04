import { merge3 } from "./merge3.ts";
import { seededRandom } from "./testing/fakes.ts";

describe("merge3", () => {
  it("merges edits in different places", () => {
    expect(merge3("a\nb\nc\nd\n", "a\nB\nc\nd\n", "a\nb\nc\nD\n").text).toBe("a\nB\nc\nD\n");
  });
  it("reports overlapping edits and keeps nothing merged", () => {
    expect(merge3("a\nb\nc\n", "a\nX\nc\n", "a\nY\nc\n")).toEqual({ text: null, reason: "overlap" });
  });
  it("takes one side when the other did not change", () => {
    expect(merge3("a\n", "a\nb\n", "a\n").text).toBe("a\nb\n");
    expect(merge3("a\n", "a\n", "a\nc\n").text).toBe("a\nc\n");
  });
  it("merges the final newline separately", () => {
    expect(merge3("a\nb", "a\nb\nc", "A\nb").text).toBe("A\nb\nc");
  });
  it("refuses a front matter assembled from two sides", () => {
    const base = "---\na: 1\nb: 1\n---\nbody\n";
    expect(merge3(base, "---\na: 2\nb: 1\n---\nbody\n", "---\na: 1\nb: 2\n---\nbody\n").reason).not.toBeNull();
  });
  it("keeps CRLF lines verbatim", () => {
    expect(merge3("a\r\nb\r\nc\r\nd\r\n", "a\r\nB\r\nc\r\nd\r\n", "a\r\nb\r\nc\r\nD\r\n").text).toBe("a\r\nB\r\nc\r\nD\r\n");
  });
  it("is symmetric on disjoint edits (seeded property)", () => {
    const rng = seededRandom(7);
    for (let n = 0; n < 300; n++) {
      const lines = Array.from({ length: 12 }, (_, i) => `l${i}`);
      const a = [...lines];
      const b = [...lines];
      const i = rng.int(5);
      const j = 7 + rng.int(5);
      a[i] = `A${n}`;
      b[j] = `B${n}`;
      const base = lines.join("\n") + "\n";
      const ra = merge3(base, a.join("\n") + "\n", b.join("\n") + "\n");
      const rb = merge3(base, b.join("\n") + "\n", a.join("\n") + "\n");
      expect(ra.text).not.toBeNull();
      expect(ra.text).toBe(rb.text);
    }
  });
});
