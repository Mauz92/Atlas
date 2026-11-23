import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { ApiError, ttrpgApi, type Encounter, type TtrpgCampaignDetail } from "../../api/client";
import { MarkdownPreview } from "../MarkdownPreview";
import { EncounterPage } from "./EncounterPage";
import { EncountersPanel } from "./EncountersPanel";

vi.mock("../../api/client", async () => {
  const actual = await vi.importActual<typeof import("../../api/client")>("../../api/client");
  return {
    ...actual,
    ttrpgApi: {
      encounter: vi.fn(),
      campaign: vi.fn(),
      party: vi.fn(),
      creatures: vi.fn(),
      updateEncounter: vi.fn(),
      addSlots: vi.fn(),
      updateSlot: vi.fn(),
      removeSlot: vi.fn(),
      refreshEncounter: vi.fn(),
      linkEncounterToNote: vi.fn(),
      encounters: vi.fn(),
      createEncounter: vi.fn(),
      runs: vi.fn().mockResolvedValue({ items: [] }),
      createRun: vi.fn(),
    },
  };
});

const api = vi.mocked(ttrpgApi);

const campaign = {
  id: "c1",
  title: "Phandelver",
  archived: false,
  sessions: [{ id: "s1", sequence: 1, title: "Session 01" }],
} as unknown as TtrpgCampaignDetail;

function encounter(overrides: Partial<Encounter> = {}): Encounter {
  return {
    id: "e1",
    campaign_id: "c1",
    title: "Goblin ambush",
    book_reference: "p. 6",
    setup_reminder: null,
    session_id: "s1",
    session_title: "Session 01",
    location: null,
    party: [],
    slots: [
      {
        id: "k1",
        position: 1,
        side: "enemy",
        creature_id: "g",
        name: "Goblin 1",
        ac: 15,
        hp: 7,
        initiative_mod: 2,
        overrides: [],
        snapshot: {},
      },
    ],
    archived: false,
    revision: 3,
    path: "/ttrpg/encounters/e1",
    link: "[Goblin ambush](/ttrpg/encounters/e1)",
    ...overrides,
  };
}

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  api.runs.mockResolvedValue({ items: [] });
  api.encounter.mockResolvedValue(encounter());
  api.campaign.mockResolvedValue(campaign);
  api.party.mockResolvedValue({
    items: [{ id: "p1", name: "Brenna" }],
    conditions: [],
  } as never);
  api.creatures.mockResolvedValue({
    items: [{ id: "g", name: "Goblin", ac: 15, hp: 7 }],
  } as never);
});

function page() {
  render(
    <MemoryRouter initialEntries={["/ttrpg/encounters/e1"]}>
      <Routes>
        <Route path="/ttrpg/encounters/:encounterId" element={<EncounterPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("EncounterPage", () => {
  it("shows the lineup with the launch link", async () => {
    page();
    expect(await screen.findByRole("heading", { name: "Goblin ambush" })).toBeInTheDocument();
    expect(screen.getByText("[Goblin ambush](/ttrpg/encounters/e1)")).toBeInTheDocument();
    expect(screen.getByLabelText("Name of Goblin 1")).toHaveValue("Goblin 1");
  });

  it("adds several slots from a card using the revision it read", async () => {
    api.addSlots.mockResolvedValue(encounter());
    page();
    await screen.findByRole("heading", { name: "Goblin ambush" });
    fireEvent.change(screen.getByLabelText("Creature"), { target: { value: "g" } });
    fireEvent.change(screen.getByLabelText("How many"), { target: { value: "3" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add from card" }));
    });
    expect(api.addSlots).toHaveBeenCalledWith(expect.objectContaining({ id: "e1", revision: 3 }), {
      creature_id: "g",
      count: 3,
      side: "enemy",
    });
  });

  it("saves a per-slot override and removes a slot", async () => {
    api.updateSlot.mockResolvedValue(encounter());
    api.removeSlot.mockResolvedValue(encounter());
    page();
    await screen.findByRole("heading", { name: "Goblin ambush" });
    fireEvent.change(screen.getByLabelText("HP of Goblin 1"), { target: { value: "12" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save Goblin 1" }));
    });
    // only the changed field is sent: anything sent counts as set by hand
    expect(api.updateSlot).toHaveBeenCalledWith(expect.anything(), "k1", { hp: 12 });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove Goblin 1" }));
    });
    expect(api.removeSlot).toHaveBeenCalledWith(expect.anything(), "k1");
  });

  it("reports what a refresh did slot by slot", async () => {
    api.refreshEncounter.mockResolvedValue({
      encounter: encounter(),
      slots: [{ slot_id: "k1", name: "Goblin 1", outcome: "card_archived" }],
    });
    page();
    await screen.findByRole("heading", { name: "Goblin ambush" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Refresh from creature cards" }));
    });
    expect(await screen.findByText(/its card is archived, kept as prepared/)).toBeInTheDocument();
  });

  it("adds the launch link to the session note and says when it was already there", async () => {
    api.linkEncounterToNote.mockResolvedValueOnce({ link: "x", changed: true });
    api.linkEncounterToNote.mockResolvedValueOnce({ link: "x", changed: false });
    page();
    await screen.findByRole("heading", { name: "Goblin ambush" });
    const button = screen.getByRole("button", { name: "Add to session note" });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(await screen.findByRole("status")).toHaveTextContent(/Link added under Prep/);
    await act(async () => {
      fireEvent.click(button);
    });
    expect(await screen.findByText(/already has this link/)).toBeInTheDocument();
  });

  it("disables the note link until a session is chosen and explains a conflict", async () => {
    api.encounter.mockResolvedValue(encounter({ session_id: null, session_title: null }));
    page();
    await screen.findByRole("heading", { name: "Goblin ambush" });
    expect(screen.getByRole("button", { name: "Add to session note" })).toBeDisabled();
    expect(screen.getByText(/Choose a session first/)).toBeInTheDocument();
  });

  it("reloads and explains a stale save", async () => {
    api.updateEncounter.mockRejectedValue(new ApiError(409, "stale", undefined));
    page();
    await screen.findByRole("heading", { name: "Goblin ambush" });
    fireEvent.change(screen.getByLabelText("Book reference"), { target: { value: "p. 7" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save book reference" }));
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(/changed elsewhere/);
    await waitFor(() => expect(api.encounter.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("changes the party with the full chosen set", async () => {
    api.updateEncounter.mockResolvedValue(encounter());
    page();
    await screen.findByRole("heading", { name: "Goblin ambush" });
    await act(async () => {
      fireEvent.click(screen.getByRole("checkbox", { name: "Brenna" }));
    });
    expect(api.updateEncounter).toHaveBeenCalledWith(expect.anything(), { party_member_ids: ["p1"] });
  });
});

describe("EncountersPanel", () => {
  it("lists encounters and creates one with a stable id", async () => {
    api.encounters.mockResolvedValue({
      items: [
        { id: "e1", campaign_id: "c1", title: "Ambush", book_reference: "p. 6", session_id: null, slot_count: 2, archived: false, revision: 1 },
      ],
    });
    api.createEncounter.mockRejectedValueOnce(new Error("offline"));
    api.createEncounter.mockResolvedValueOnce(encounter());
    render(
      <MemoryRouter>
        <EncountersPanel campaign={campaign} />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("link", { name: "Ambush" })).toHaveAttribute("href", "/ttrpg/encounters/e1");
    expect(screen.getByText(/2 combatants/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("New encounter"), { target: { value: "Wolves" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Prepare encounter" }));
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("offline");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Prepare encounter" }));
    });
    expect(api.createEncounter.mock.calls[1][1].id).toBe(api.createEncounter.mock.calls[0][1].id);
  });
});

describe("launch links in notes", () => {
  it("navigates inside the app for /ttrpg links and leaves other links alone", () => {
    const navigate = vi.fn();
    render(
      <MarkdownPreview
        content={"[Ambush](/ttrpg/encounters/e1) and [web](https://example.com) and [odd](/ttrpg/..%2Fx)"}
        onNavigate={navigate}
      />,
    );
    fireEvent.click(screen.getByRole("link", { name: "Ambush" }));
    expect(navigate).toHaveBeenCalledWith("/ttrpg/encounters/e1");
    navigate.mockClear();
    fireEvent.click(screen.getByRole("link", { name: "web" }));
    fireEvent.click(screen.getByRole("link", { name: "odd" }));
    fireEvent.click(screen.getByRole("link", { name: "Ambush" }), { ctrlKey: true });
    expect(navigate).not.toHaveBeenCalled();
  });
});
