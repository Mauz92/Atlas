import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { ApiError, ttrpgApi, type TtrpgCampaignDetail } from "../../api/client";
import { CampaignList } from "./CampaignList";
import { CampaignPage } from "./CampaignPage";

vi.mock("../../api/client", async () => {
  const actual = await vi.importActual<typeof import("../../api/client")>("../../api/client");
  return {
    ...actual,
    notesApi: { list: vi.fn().mockResolvedValue({ notes: [{ id: "n9", path: "Mine/Replacement.md" }], folders: [] }) },
    ttrpgApi: {
      campaigns: vi.fn(),
      createCampaign: vi.fn(),
      campaign: vi.fn(),
      updateCampaign: vi.fn(),
      addSession: vi.fn(),
      session: vi.fn(),
      updateSession: vi.fn(),
      relink: vi.fn(),
      party: vi.fn().mockResolvedValue({ items: [], conditions: [] }),
      runs: vi.fn().mockResolvedValue({ items: [] }),
      campaignNotes: vi.fn().mockResolvedValue({ items: [] }),
      createCampaignNote: vi.fn(),
      encounters: vi.fn().mockResolvedValue({ items: [] }),
      createEncounter: vi.fn(),
    },
  };
});

const api = vi.mocked(ttrpgApi);

const link = (id: string | null, missing = false) => ({
  note_id: id,
  path: id ? `TTRPG/C/${id}.md` : null,
  title: id ? `Note ${id}` : null,
  missing,
});

function detail(overrides: Partial<TtrpgCampaignDetail> = {}): TtrpgCampaignDetail {
  return {
    id: "c1",
    title: "Lost Mine",
    rules_preset: "dnd5e-2014",
    book_title: "LMoP",
    folder: "TTRPG/Lost Mine",
    archived: false,
    revision: 1,
    created_at: "2026-11-23T00:00:00Z",
    home: link("home"),
    sessions: [
      {
        id: "s1",
        campaign_id: "c1",
        title: "Session 01",
        sequence: 1,
        session_date: null,
        status: "planned",
        revision: 1,
        note: link("n1"),
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  api.party.mockResolvedValue({ items: [], conditions: [] });
  api.encounters.mockResolvedValue({ items: [] });
  api.runs.mockResolvedValue({ items: [] });
  api.campaignNotes.mockResolvedValue({ items: [] });
});

describe("CampaignList", () => {
  it("shows the empty state, then creates with one id that survives a failed attempt", async () => {
    api.campaigns.mockResolvedValue({ items: [] });
    api.createCampaign.mockRejectedValueOnce(new ApiError(500, "boom", undefined));
    api.createCampaign.mockResolvedValueOnce(detail());
    render(
      <MemoryRouter>
        <CampaignList />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/No campaigns yet/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Lost Mine" } });
    fireEvent.change(screen.getByLabelText(/Book/), { target: { value: "LMoP" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create campaign" }));
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create campaign" }));
    });
    expect(api.createCampaign).toHaveBeenCalledTimes(2);
    const first = api.createCampaign.mock.calls[0][0];
    const second = api.createCampaign.mock.calls[1][0];
    expect(second.id).toBe(first.id);
    expect(first).toMatchObject({ title: "Lost Mine", book_title: "LMoP", folder: null });
    await waitFor(() => expect(screen.getByLabelText("Title")).toHaveValue(""));
  });

  it("lists campaigns and reports a load failure", async () => {
    api.campaigns.mockResolvedValueOnce({
      items: [{ ...detail(), home: link("home") }],
    });
    render(
      <MemoryRouter>
        <CampaignList />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("link", { name: "Lost Mine" })).toHaveAttribute(
      "href",
      "/ttrpg/c1",
    );
  });
});

function page() {
  render(
    <MemoryRouter initialEntries={["/ttrpg/c1"]}>
      <Routes>
        <Route path="/ttrpg/:campaignId" element={<CampaignPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("CampaignPage", () => {
  it("links notes by id and shows the previous session's handoff", async () => {
    api.campaign.mockResolvedValue(detail());
    api.session.mockResolvedValue({
      ...detail().sessions[0],
      previous: {
        session_id: "s0",
        title: "Session 00",
        note: link("n0"),
        handoff: "Ambush on the road",
      },
    });
    page();
    expect(await screen.findByRole("link", { name: "Note home" })).toHaveAttribute(
      "href",
      "/notes?open=home",
    );
    fireEvent.click(screen.getByRole("button", { name: /Session 01/ }));
    expect(await screen.findByText("Ambush on the road")).toBeInTheDocument();
  });

  it("offers to recreate a missing note and reloads", async () => {
    api.campaign
      .mockResolvedValueOnce(detail({ home: link("home", true) }))
      .mockResolvedValueOnce(detail());
    api.relink.mockResolvedValue(detail());
    page();
    await screen.findByText("Note missing");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Recreate note" }));
    });
    expect(api.relink).toHaveBeenCalledWith("c1", "home");
    expect(await screen.findByRole("link", { name: "Note home" })).toBeInTheDocument();
  });

  it("links an existing note to a missing one, with the note's id", async () => {
    api.campaign.mockResolvedValueOnce(detail({ home: link("home", true) })).mockResolvedValueOnce(detail());
    api.relink.mockResolvedValue(detail());
    page();
    await screen.findByText("Note missing");
    fireEvent.click(screen.getByRole("button", { name: "Link another note" }));
    fireEvent.change(await screen.findByLabelText("Note to link"), { target: { value: "n9" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Link this note" }));
    });
    expect(api.relink).toHaveBeenCalledWith("c1", "home", "n9");
  });

  it("collects the campaign's notes by kind and adds an NPC note", async () => {
    const note = (id: string, kind: "home" | "session" | "npc" | "location" | "other", title: string, label: string | null = null) => ({
      id, kind, title, label, path: `TTRPG/Lost Mine/${title}.md`,
    });
    api.campaign.mockResolvedValue(detail());
    api.campaignNotes
      .mockResolvedValueOnce({
        items: [
          note("h", "home", "Lost Mine"),
          note("s1", "session", "Session 01", "1. Session 01"),
          note("n1", "npc", "Sildar Hallwinter"),
          note("l1", "location", "Cragmaw Hideout"),
          note("o1", "other", "Loot list"),
        ],
      })
      .mockResolvedValue({ items: [] });
    api.createCampaignNote.mockResolvedValue(note("n2", "npc", "Klarg"));
    page();
    const group = async (name: string) => within(await screen.findByRole("group", { name }));
    expect((await group("Campaign home")).getByRole("link", { name: "Lost Mine" })).toHaveAttribute("href", "/notes?open=h");
    expect((await group("Sessions")).getByRole("link", { name: "1. Session 01" })).toBeInTheDocument();
    expect((await group("NPCs")).getByRole("link", { name: "Sildar Hallwinter" })).toBeInTheDocument();
    expect((await group("Locations")).getByRole("link", { name: "Cragmaw Hideout" })).toBeInTheDocument();
    expect((await group("Other notes")).getByRole("link", { name: "Loot list" })).toBeInTheDocument();
    const form = (await screen.findByRole("button", { name: "Add note" })).closest("form")!;
    fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "Klarg" } });
    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: "Add note" }));
    });
    expect(api.createCampaignNote).toHaveBeenCalledWith("c1", { kind: "npc", title: "Klarg" });
  });

  it("creates sessions with a fresh id, changes status, and reloads after a conflict", async () => {
    api.campaign.mockResolvedValue(detail());
    api.addSession.mockResolvedValue({} as never);
    api.updateSession.mockRejectedValue(new ApiError(409, "stale", undefined));
    page();
    await screen.findByRole("button", { name: /Session 01/ });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "New session" }));
    });
    expect(api.addSession).toHaveBeenCalledWith("c1", { id: expect.any(String) });
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Status of Session 01"), {
        target: { value: "active" },
      });
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(/changed elsewhere/);
    expect(api.campaign.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("archives a campaign with its current revision", async () => {
    api.campaign.mockResolvedValue(detail({ revision: 4 }));
    api.updateCampaign.mockResolvedValue(detail());
    page();
    const archive = await screen.findByRole("button", { name: "Archive campaign" });
    await act(async () => {
      fireEvent.click(archive);
    });
    expect(api.updateCampaign).toHaveBeenCalledWith(expect.objectContaining({ revision: 4 }), {
      archived: true,
    });
  });
});
