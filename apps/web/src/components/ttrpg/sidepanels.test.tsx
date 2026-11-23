import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { ttrpgApi } from "../../api/client";
import { SidePanels } from "./SidePanels";

vi.mock("../NoteEditor", () => ({
  NoteEditor: ({ value }: { value: string }) => <textarea aria-label="Note text" readOnly value={value} />,
}));
vi.mock("../../hooks/useNoteAutosave", () => ({ useNoteAutosave: () => ({ session: { change: vi.fn() }, snapshot: null }) }));
vi.mock("../../api/client", async () => {
  const actual = await vi.importActual<typeof import("../../api/client")>("../../api/client");
  return {
    ...actual,
    notesApi: { get: vi.fn().mockResolvedValue({ id: "n1", title: "Sildar", content: "# Sildar\n", revision: 1 }) },
    ttrpgApi: {
      campaignNotes: vi.fn().mockResolvedValue({
        items: [{ id: "n1", kind: "npc", title: "Sildar", label: null, path: "TTRPG/C/NPCs/Sildar.md" }],
      }),
      party: vi.fn().mockResolvedValue({
        conditions: [],
        items: [
          {
            id: "m1", name: "Brenna", role: "pc", level: 3, ac: 17, max_hp: 28, speed: 30, initiative_mod: 1, passive_perception: 12,
            attacks: [{ name: "Longsword", to_hit: 5, damage: "1d8+3 slashing", notes: "" }], abilities: [],
            resources: [{ key: "second-wind", name: "Second Wind", max: 1, reset: "short" }], archived: false, campaign_id: "c1", revision: 1,
            state: { current_hp: 20, temp_hp: 0, conditions: [], exhaustion_level: 0, death_save_successes: 0, death_save_failures: 0, resources_used: {}, revision: 1 },
          },
        ],
      }),
    },
  };
});
const api = vi.mocked(ttrpgApi);

beforeEach(() => {
  window.localStorage.removeItem("atlas-ttrpg-sidebar");
});

describe("SidePanels", () => {
  it("starts with the rules reference and lets you add and close panels", async () => {
    render(<SidePanels campaignId="c1" />);
    expect(screen.getByRole("tab", { name: "Rules" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Search the rules")).toBeInTheDocument();

    fireEvent.click(screen.getByText("+ Add panel"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Party sheet" }));
    expect(screen.getByRole("tab", { name: "Party" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("Longsword")).toBeInTheDocument();
    expect(screen.getByText(/Second Wind: 1\/1 left/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close the party panel" }));
    expect(screen.queryByRole("tab", { name: "Party" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Rules" })).toHaveAttribute("aria-selected", "true");
  });

  it("can replace the rules reference: close it and add something else", async () => {
    render(<SidePanels campaignId="c1" />);
    fireEvent.click(screen.getByRole("button", { name: "Close the rules panel" }));
    expect(screen.getByText(/Nothing here yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("+ Add panel"));
    fireEvent.click(screen.getByRole("menuitem", { name: "A campaign note" }));
    const pick = await screen.findByLabelText("Note to show");
    await waitFor(() => expect(within(pick).getByRole("option", { name: "Sildar" })).toBeInTheDocument());
    await act(async () => {
      fireEvent.change(pick, { target: { value: "n1" } });
    });
    expect(await screen.findByLabelText("Note text")).toHaveValue("# Sildar\n");
    expect(api.campaignNotes).toHaveBeenCalledWith("c1");
  });

  it("remembers the choice in this browser", () => {
    const { unmount } = render(<SidePanels campaignId="c1" />);
    fireEvent.click(screen.getByText("+ Add panel"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Party sheet" }));
    unmount();
    render(<SidePanels campaignId="c1" />);
    expect(screen.getByRole("tab", { name: "Rules" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Party" })).toBeInTheDocument();
  });

  it("ignores a damaged stored choice", () => {
    window.localStorage.setItem("atlas-ttrpg-sidebar", JSON.stringify([{ id: "x", kind: "bogus" }, 7, { id: "y", kind: "party" }]));
    render(<SidePanels campaignId="c1" />);
    expect(screen.queryByRole("tab", { name: "Rules" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Party" })).toBeInTheDocument();
    window.localStorage.setItem("atlas-ttrpg-sidebar", "not json");
    render(<SidePanels campaignId="c1" />);
    expect(screen.getAllByRole("tab", { name: "Rules" }).length).toBeGreaterThan(0);
  });

  it("brings the rules forward for a requested rule, adding the panel if it was closed", async () => {
    window.localStorage.setItem("atlas-ttrpg-sidebar", JSON.stringify([{ id: "p", kind: "party" }]));
    render(<SidePanels campaignId="c1" ruleRequest={{ id: "prone", tick: 1 }} />);
    expect(await screen.findByRole("tab", { name: "Rules" })).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(screen.getByText("Prone").closest("details")!.open).toBe(true));
  });
});
