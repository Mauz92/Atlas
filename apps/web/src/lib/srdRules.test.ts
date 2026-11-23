import { RULES, RULE_GROUPS, SRD_ATTRIBUTION, findRule, searchRules } from "./srdRules";

describe("the SRD 5.1 rules data", () => {
  it("carries Wizards' own attribution statement, and nothing else about them", () => {
    expect(SRD_ATTRIBUTION).toBe(
      "This work includes material taken from the System Reference Document 5.1 " +
        "(“SRD 5.1”) by Wizards of the Coast LLC and available at " +
        "https://dnd.wizards.com/resources/systems-reference-document. The SRD 5.1 is licensed under " +
        "the Creative Commons Attribution 4.0 International License available at " +
        "https://creativecommons.org/licenses/by/4.0/legalcode.",
    );
    expect(SRD_ATTRIBUTION.split("Wizards").length - 1).toBe(1);
  });

  it("has unique, URL-safe ids, only known groups and no empty entries", () => {
    const ids = RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of RULES) {
      expect(rule.id).toMatch(/^[a-z0-9-]+$/);
      expect(RULE_GROUPS).toContain(rule.group);
      expect(rule.title.trim()).not.toBe("");
      expect(rule.body.length).toBeGreaterThan(0);
    }
  });

  it("has every condition of the 2014 rules, by lower-case name (the fight screen links to them)", () => {
    const names = [
      "blinded", "charmed", "deafened", "exhaustion", "frightened", "grappled", "incapacitated", "invisible",
      "paralyzed", "petrified", "poisoned", "prone", "restrained", "stunned", "unconscious",
    ];
    for (const name of names) expect(findRule(name)?.group).toBe("Conditions");
    expect(RULES.filter((rule) => rule.group === "Conditions")).toHaveLength(names.length);
  });

  it("quotes the rulebook exactly where it matters at the table", () => {
    const prone = findRule("prone")!;
    expect(JSON.stringify(prone.body)).toContain("An attack roll against the creature has advantage if the attacker is within 5 feet of the creature.");
    const half = JSON.stringify(findRule("cover")!.body);
    expect(half).toContain("+2 bonus to AC and Dexterity saving throws");
    expect(half).toContain("+5 bonus to AC and Dexterity saving throws");
    expect(JSON.stringify(findRule("deathsave")!.body)).toContain("If the roll is 10 or higher, you succeed.");
  });

  it("searches titles and text, all words, case-insensitively, in listing order", () => {
    expect(searchRules("")).toHaveLength(RULES.length);
    expect(searchRules("PRONE").map((r) => r.id)).toContain("prone");
    expect(searchRules("three-quarters cover").map((r) => r.id)).toEqual(["cover"]);
    expect(searchRules("zzzzqqq")).toEqual([]);
    expect(searchRules("death saving").map((r) => r.id)).toContain("deathsave");
  });

  it("contains plain text only: no markup that could ever be rendered as HTML", () => {
    const all = JSON.stringify(RULES);
    expect(all).not.toMatch(/<\/?[a-z][^>]*>/i);
  });
});
