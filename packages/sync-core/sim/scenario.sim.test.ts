import { ModelServer } from "./model/server.ts";
import { runScenario } from "./scenario.ts";

describe("scripted two-device scenario on the model server", () => {
  it("produces the outcomes the protocol prescribes", async () => {
    const outcomes = await runScenario(new ModelServer());
    const text = outcomes.join("\n");
    expect(text).toContain("B patch task -> 409 conflict"); // same text field changed on both sides
    expect(text).toContain("res=simple_later_wins");
    expect(text).toContain("B delete project -> 409 edit_wins");
    expect(text).toContain("res=path_collision");
    expect(text).toMatch(/res=note_merged/);
    expect(text).toMatch(/copy=.*\(conflict\)/);
    expect(text).toContain("revived=true");
  });
  it("is deterministic", async () => {
    expect(await runScenario(new ModelServer())).toEqual(await runScenario(new ModelServer()));
  });
});
