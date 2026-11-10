import { describeHalt } from "./haltText";

describe("halt wording", () => {
  it("restore: epoch change explains the loss and shows what this device holds", () => {
    const t = describeHalt({ kind: "restore_confirmation", reason: "epoch_mismatch", epoch: "e2", head: null }, { pending: 3, cursor: 40 });
    expect(t.title).toMatch(/restored from a backup/);
    expect(t.body.join(" ")).toMatch(/Nothing happens until you choose/);
    expect(t.facts).toEqual([{ label: "Unsent changes on this device", value: "3" }]);
  });

  it("restore: cursor_ahead shows both positions", () => {
    const t = describeHalt({ kind: "restore_confirmation", reason: "cursor_ahead", epoch: null, head: 12 }, { pending: 0, cursor: 40 });
    expect(t.facts.map((f) => f.value)).toEqual(["change 12", "change 40", "0"]);
  });

  it("update required says the data is kept; signed out says nothing was deleted", () => {
    const u = describeHalt({ kind: "update_required", min: 1, max: 1 }, { pending: 2, cursor: 0 });
    expect(u.body.join(" ")).toMatch(/protocol 1 to 1/);
    expect(u.body.join(" ")).toMatch(/2 unsent changes/);
    const s = describeHalt({ kind: "signed_out", code: "token_revoked" }, { pending: 1, cursor: 0 });
    expect(s.body.join(" ")).toMatch(/signed out from another device/);
    expect(s.body.join(" ")).toMatch(/1 unsent change will be sent/);
  });
});
