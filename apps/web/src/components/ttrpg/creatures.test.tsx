import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { ApiError, ttrpgApi, type Creature } from "../../api/client";
import { CreatureLibrary } from "./CreatureLibrary";

vi.mock("../../api/client", async () => {
  const actual = await vi.importActual<typeof import("../../api/client")>("../../api/client");
  return {
    ...actual,
    ttrpgApi: {
      creatures: vi.fn(),
      createCreature: vi.fn(),
      updateCreature: vi.fn(),
      duplicateCreature: vi.fn(),
      archiveCreature: vi.fn(),
      refreshCreature: vi.fn(),
      searchSrd: vi.fn(),
      importSrd: vi.fn(),
    },
  };
});

const api = vi.mocked(ttrpgApi);
const NOTICE = "This work includes material taken from the System Reference Document 5.1.";

function card(overrides: Partial<Creature> = {}): Creature {
  return {
    id: "g1",
    name: "Goblin",
    ac: 15,
    hp: 7,
    speed: "walk 30 ft.",
    initiative_mod: 2,
    challenge_rating: "1/4",
    size: "Small",
    creature_type: "humanoid",
    traits: [{ name: "Nimble Escape", text: "Disengage as a bonus action." }],
    actions: [{ name: "Scimitar", text: "Melee.", kind: "action", to_hit: 4, damage: "1d6+2 Slashing" }],
    source: "srd",
    source_edition: "2014",
    external_id: "goblin",
    attribution: NOTICE,
    imported_at: "2026-11-23T00:00:00Z",
    derived_from_id: null,
    archived: false,
    revision: 1,
    ...overrides,
  };
}

function page() {
  render(
    <MemoryRouter>
      <CreatureLibrary />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  api.creatures.mockResolvedValue({ items: [card()] });
});

describe("CreatureLibrary", () => {
  it("shows an imported card with its attribution and no edit button", async () => {
    page();
    fireEvent.click(await screen.findByRole("button", { name: "Goblin" }));
    expect(screen.getByText(NOTICE)).toBeInTheDocument();
    expect(screen.getByText(/Nimble Escape\./)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Edit Goblin/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh from SRD" })).toBeInTheDocument();
  });

  it("renders catalogue text as text, never as markup", async () => {
    api.creatures.mockResolvedValue({
      items: [card({ traits: [{ name: "Trap", text: "<img src=x onerror=alert(1)>" }] })],
    });
    page();
    fireEvent.click(await screen.findByRole("button", { name: "Goblin" }));
    expect(screen.getByText(/<img src=x onerror=alert\(1\)>/)).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
  });

  it("duplicates into a variant and refreshes explicitly", async () => {
    api.duplicateCreature.mockResolvedValue(card({ id: "v1" }));
    api.refreshCreature.mockResolvedValue(card());
    page();
    fireEvent.click(await screen.findByRole("button", { name: "Goblin" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Duplicate as variant" }));
    });
    expect(api.duplicateCreature).toHaveBeenCalledWith("g1", expect.any(String));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Refresh from SRD" }));
    });
    expect(api.refreshCreature).toHaveBeenCalledWith(expect.objectContaining({ id: "g1", revision: 1 }));
  });

  it("edits only manual cards", async () => {
    api.creatures.mockResolvedValue({
      items: [card({ id: "m1", name: "Homebrew", source: "manual", external_id: null, attribution: null })],
    });
    api.updateCreature.mockResolvedValue(card());
    page();
    fireEvent.click(await screen.findByRole("button", { name: "Homebrew" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit Homebrew" }));
    fireEvent.change(screen.getByLabelText("HP"), { target: { value: "30" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save creature" }));
    });
    expect(api.updateCreature).toHaveBeenCalledWith(
      expect.objectContaining({ id: "m1" }),
      expect.objectContaining({ hp: 30, name: "Homebrew" }),
    );
  });

  it("creates a manual card with one id that survives a failed attempt", async () => {
    api.creatures.mockResolvedValue({ items: [] });
    api.createCreature.mockRejectedValueOnce(new Error("offline"));
    api.createCreature.mockResolvedValueOnce(card());
    page();
    fireEvent.click(await screen.findByRole("button", { name: "New creature" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ogre" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create creature" }));
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("offline");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create creature" }));
    });
    expect(api.createCreature.mock.calls[1][0].id).toBe(api.createCreature.mock.calls[0][0].id);
  });

  it("searches the SRD, imports, and shows the notice", async () => {
    api.searchSrd.mockResolvedValue({
      attribution: NOTICE,
      items: [
        { index: "goblin", name: "Goblin", imported_as: null },
        { index: "wolf", name: "Wolf", imported_as: "w1" },
      ],
    });
    api.importSrd.mockResolvedValue(card());
    page();
    await screen.findByRole("button", { name: "Goblin" });
    fireEvent.change(screen.getByLabelText("Search the SRD"), { target: { value: "go" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Search" }));
    });
    const section = (await screen.findByText("Wolf")).closest("section")!;
    expect(within(section).getByText("Imported")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(within(section).getByRole("button", { name: "Import Goblin" }));
    });
    expect(api.importSrd).toHaveBeenCalledWith("goblin");
    expect(within(section).getByText(NOTICE)).toBeInTheDocument();
  });

  it("explains an unavailable catalogue and leaves the library usable", async () => {
    api.searchSrd.mockRejectedValue(new ApiError(502, "The monster catalogue is not available right now. Manual creature cards still work.", undefined));
    page();
    await screen.findByRole("button", { name: "Goblin" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Search" }));
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(/Manual creature cards still work/);
    await waitFor(() => expect(screen.getByRole("button", { name: "New creature" })).toBeEnabled());
  });
});
