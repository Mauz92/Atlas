import { hpTag, hpTone } from "./hp";

describe("health bar tone and label", () => {
  it("is green above half, amber above a quarter, red below, grey at zero", () => {
    expect([28, 15, 14, 8, 7, 1, 0].map((hp) => hpTone(hp, 28))).toEqual(["ok", "ok", "warn", "warn", "crit", "crit", "zero"]);
  });
  it("says Bloodied at half or less, and the down label at 0, and nothing otherwise", () => {
    expect(hpTag(28, 28, "Down")).toBe("");
    expect(hpTag(15, 28, "Down")).toBe("");
    expect(hpTag(14, 28, "Down")).toBe("Bloodied");
    expect(hpTag(1, 28, "Down")).toBe("Bloodied");
    expect(hpTag(0, 28, "Down")).toBe("Down");
    expect(hpTag(0, 7, "0 HP")).toBe("0 HP");
  });
});
