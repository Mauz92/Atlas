import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { ApiError, ttrpgApi, type PartyMember } from "../../api/client";
import { PartyPanel } from "./PartyPanel";

vi.mock("../../api/client", async () => {
  const actual = await vi.importActual<typeof import("../../api/client")>("../../api/client");
  return {
    ...actual,
    ttrpgApi: {
      party: vi.fn(),
      addMember: vi.fn(),
      updateCard: vi.fn(),
      archiveMember: vi.fn(),
      updateState: vi.fn(),
      adjustHp: vi.fn(),
      previewRest: vi.fn(),
      applyRest: vi.fn(),
    },
  };
});

const api = vi.mocked(ttrpgApi);
const CONDITIONS = ["poisoned", "prone"];

function member(overrides: Partial<PartyMember> = {}, state: Partial<PartyMember["state"]> = {}): PartyMember {
  return {
    id: "m1",
    campaign_id: "c1",
    archived: false,
    revision: 1,
    role: "pc",
    name: "Brenna",
    level: 3,
    ac: 17,
    max_hp: 28,
    speed: 30,
    initiative_mod: 1,
    passive_perception: 12,
    attacks: [],
    abilities: [],
    resources: [{ key: "second-wind", name: "Second Wind", max: 1, reset: "short" }],
    state: {
      current_hp: 20,
      temp_hp: 0,
      conditions: [],
      exhaustion_level: 0,
      death_save_successes: 0,
      death_save_failures: 0,
      resources_used: {},
      revision: 1,
      ...state,
    },
    ...overrides,
  };
}

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  api.party.mockResolvedValue({ items: [member()], conditions: CONDITIONS });
});

async function open() {
  render(<PartyPanel campaignId="c1" archived={false} />);
  await screen.findByRole("heading", { name: /Brenna/, level: 3 });
}

describe("PartyPanel", () => {
  it("shows the card with a health bar", async () => {
    await open();
    expect(screen.getByRole("img", { name: /Brenna: 20 of 28 hit points/ })).toBeInTheDocument();
    expect(screen.getByText("17")).toBeInTheDocument();
    expect(screen.getByText(/Second Wind: 1\/1 left/)).toBeInTheDocument();
  });

  it("sets typed HP and nudged HP by hand, with the revision it read", async () => {
    api.updateState.mockResolvedValue(member());
    await open();
    const hp = screen.getByLabelText("Current HP of Brenna");
    fireEvent.change(hp, { target: { value: "11" } });
    await act(async () => {
      fireEvent.blur(hp);
    });
    expect(api.updateState).toHaveBeenLastCalledWith(expect.objectContaining({ id: "m1" }), { current_hp: 11 });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Minus 5 HP for Brenna" }));
    });
    expect(api.updateState).toHaveBeenLastCalledWith(expect.anything(), { current_hp: 15 });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Plus 5 HP for Brenna" }));
    });
    expect(api.updateState).toHaveBeenLastCalledWith(expect.anything(), { current_hp: 25 });
    expect(api.party.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps HP between 0 and the maximum and ignores unchanged or blank input", async () => {
    api.updateState.mockResolvedValue(member());
    api.party.mockResolvedValue({ items: [member({}, { current_hp: 27 })], conditions: CONDITIONS });
    await open();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Plus 5 HP for Brenna" }));
    });
    expect(api.updateState).toHaveBeenLastCalledWith(expect.anything(), { current_hp: 28 });
    const before = api.updateState.mock.calls.length;
    const hp = screen.getByLabelText("Current HP of Brenna");
    fireEvent.change(hp, { target: { value: "" } });
    await act(async () => {
      fireEvent.blur(hp);
    });
    expect(api.updateState.mock.calls.length).toBe(before);
  });

  it("sets temporary HP to exactly the number typed", async () => {
    api.updateState.mockResolvedValue(member());
    await open();
    const temp = screen.getByLabelText("Temporary HP of Brenna");
    fireEvent.change(temp, { target: { value: "4" } });
    await act(async () => {
      fireEvent.blur(temp);
    });
    expect(api.updateState).toHaveBeenLastCalledWith(expect.anything(), { temp_hp: 4 });
  });

  it("explains a conflict and reloads instead of overwriting", async () => {
    api.updateState.mockRejectedValue(new ApiError(409, "stale", undefined));
    await open();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Plus 1 HP for Brenna" }));
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(/changed this elsewhere/);
  });

  it("toggles conditions and spends and restores resources", async () => {
    api.updateState.mockResolvedValue(member());
    await open();
    await act(async () => {
      fireEvent.click(screen.getByRole("checkbox", { name: "poisoned" }));
    });
    expect(api.updateState).toHaveBeenLastCalledWith(expect.anything(), { conditions: ["poisoned"] });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Spend Second Wind" }));
    });
    expect(api.updateState).toHaveBeenLastCalledWith(expect.anything(), {
      resources_used: { "second-wind": 1 },
    });
    expect(screen.getByRole("button", { name: "Restore Second Wind" })).toBeDisabled();
  });

  it("shows death saves only at 0 HP", async () => {
    api.party.mockResolvedValue({
      items: [member({}, { current_hp: 0, death_save_failures: 1 })],
      conditions: CONDITIONS,
    });
    await open();
    expect(screen.getByText("Death saves")).toBeInTheDocument();
  });

  it("adds a member with one id that is reused after a failure", async () => {
    api.party.mockResolvedValue({ items: [], conditions: CONDITIONS });
    api.addMember.mockRejectedValueOnce(new Error("offline"));
    api.addMember.mockResolvedValueOnce(member());
    render(<PartyPanel campaignId="c1" archived={false} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add member" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Sildar" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add to party" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add to party" }));
    });
    const [, first] = api.addMember.mock.calls[0];
    const [, second] = api.addMember.mock.calls[1];
    expect(second.id).toBe(first.id);
    expect(first).toMatchObject({ name: "Sildar", ac: 10, max_hp: 10 });
  });

  it("previews a rest, lets the DM set HP, and applies only the confirmed members", async () => {
    api.previewRest.mockResolvedValue({
      kind: "long",
      notes: [],
      members: [
        {
          member_id: "m1",
          name: "Brenna",
          state_revision: 4,
          hp: { before: 20, after: 28 },
          temp_hp: null,
          exhaustion_level: null,
          death_saves_cleared: false,
          resources_used: {},
          unchanged: false,
        },
        {
          member_id: "m2",
          name: "Sildar",
          state_revision: 2,
          hp: null,
          temp_hp: null,
          exhaustion_level: null,
          death_saves_cleared: false,
          resources_used: {},
          unchanged: true,
        },
      ],
    });
    api.applyRest.mockResolvedValue({ items: [member()], conditions: CONDITIONS });
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Rest…" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(/HP 20 → 28/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Sildar" })); // skip
    fireEvent.change(within(dialog).getByLabelText("Set HP for Brenna"), { target: { value: "25" } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Apply rest" }));
    });
    expect(api.applyRest).toHaveBeenCalledWith("c1", "long", [
      { member_id: "m1", base_revision: 4, overrides: { current_hp: 25 } },
    ]);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("tells the DM when the party changed since the preview", async () => {
    api.previewRest.mockResolvedValue({ kind: "long", notes: [], members: [] });
    api.applyRest.mockRejectedValue(new ApiError(409, "stale", undefined));
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Rest…" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Apply rest" })).toBeEnabled());
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Apply rest" }));
    });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/changed since this preview/);
  });

  it("retires a member", async () => {
    api.archiveMember.mockResolvedValue(member());
    await open();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retire" }));
    });
    expect(api.archiveMember).toHaveBeenCalledWith(expect.objectContaining({ id: "m1" }), true);
  });
});
