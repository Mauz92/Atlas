import { fuzzyScore, rankByQuery } from "./palette";

describe("fuzzyScore", () => {
  it.each([
    ["tasks", "Tasks"],
    ["TSK", "Tasks"],
    ["ask", "Tasks"],
    ["", "anything"],
  ])("%s matches %s", (query, text) => {
    expect(fuzzyScore(query, text)).not.toBeNull();
  });

  it.each([
    ["zzz", "Tasks"],
    ["sk t", "Tasks"],
  ])("%s does not match %s", (query, text) => {
    expect(fuzzyScore(query, text)).toBeNull();
  });

  it("prefers a prefix over a word start over a substring over a subsequence", () => {
    const scores = [
      fuzzyScore("no", "Notes"),
      fuzzyScore("no", "Go to Notes"),
      fuzzyScore("no", "Piano"),
      fuzzyScore("nt", "Notes"),
    ];
    expect(scores).toEqual([...scores].sort((a, b) => (a as number) - (b as number)));
  });
});

describe("rankByQuery", () => {
  it("filters and orders by score, keeping input order for ties", () => {
    const items = ["Go to Notes", "Go to Tasks", "Toggle theme", "Notifications"];
    expect(rankByQuery(items, "no", (item) => item)).toEqual(["Notifications", "Go to Notes"]);
    expect(rankByQuery(items, "", (item) => item)).toEqual(items);
  });
});
