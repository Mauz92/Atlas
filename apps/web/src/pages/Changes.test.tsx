import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { setDefaultResolutionsSource } from "../lib/syncUi/source";
import { fakeSource, resolution } from "../test/syncUi";
import { Changes } from "./Changes";

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return {
    ...actual,
    tasksApi: { get: vi.fn(async () => ({ title: "Pay rent" })) },
    projectsApi: { get: vi.fn() },
    notesApi: { get: vi.fn() },
  };
});

function renderPage() {
  return render(
    <MemoryRouter>
      <Changes />
    </MemoryRouter>,
  );
}

afterEach(() => setDefaultResolutionsSource(null));

describe("Changes page", () => {
  it("lists entries with device, time, replaced value and an Undo wired to the source with one key per tap", async () => {
    const source = fakeSource([[resolution()]]);
    setDefaultResolutionsSource(source);
    renderPage();
    const list = await screen.findByRole("list", { name: "Changes from other devices" });
    const card = within(list).getByRole("listitem");
    expect(await within(card).findByText("Pay rent")).toBeInTheDocument();
    expect(card).toHaveTextContent("Kim's laptop");
    expect(card).toHaveTextContent("Replaced status");
    expect(card).toHaveTextContent("In progress");
    fireEvent.click(within(card).getByRole("button", { name: /Undo the change to the status of Pay rent/ }));
    expect(await within(card).findByText(/Undone: the status has its earlier value again/)).toBeInTheDocument();
    expect(source.undoCalls).toHaveLength(1);
  });

  it("a retry after a lost answer reuses the same Idempotency-Key", async () => {
    const outcomes = [
      { kind: "unreachable", message: "Could not reach the server.", safe: true, refresh: false, followUp: null },
      { kind: "undone", message: "Undone.", safe: true, refresh: false, followUp: null },
    ] as const;
    let call = 0;
    const source = fakeSource([[resolution()]], { undo: async (r, key) => { source.undoCalls.push({ id: r.id, key }); return outcomes[call++]!; } });
    setDefaultResolutionsSource(source);
    renderPage();
    const button = await screen.findByRole("button", { name: /Undo the change/ });
    fireEvent.click(button);
    await screen.findByText(/Could not reach the server/);
    fireEvent.click(screen.getByRole("button", { name: /Undo the change/ }));
    await waitFor(() => expect(source.undoCalls).toHaveLength(2));
    expect(source.undoCalls[0]!.key).toBe(source.undoCalls[1]!.key);
  });

  it("shows a refusal as a plain message and keeps the Undo button for another try", async () => {
    const source = fakeSource([[resolution()]], {
      undo: async () => ({ kind: "changed_since", message: "Not undone: the status was changed again since.", safe: true, refresh: false, followUp: null }),
    });
    setDefaultResolutionsSource(source);
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Undo the change/ }));
    const message = await screen.findByText(/changed again since/);
    expect(message).toHaveAttribute("role", "status");
    expect(screen.getByRole("button", { name: /Undo the change/ })).toBeEnabled();
  });

  it("shows why a kind cannot be undone, with the follow-up link, and no Undo button", async () => {
    const source = fakeSource([[
      resolution({ id: "r2", rule: "edit_wins_over_delete", field: null, has_loser: false, undoable: false, undo_blocked: "rule_not_undoable", follow_up: { kind: "delete_again", href: null } }),
    ]]);
    setDefaultResolutionsSource(source);
    renderPage();
    expect(await screen.findByText(/the edit won and the item came back/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Undo/ })).toBeNull();
    expect(screen.getByRole("link", { name: "Delete the task again" })).toHaveAttribute("href", "/tasks?task=t1");
  });

  it("pages: older entries load on request", async () => {
    const source = fakeSource([[resolution({ id: "new" })], [resolution({ id: "old", field: "priority", loser: "low", created_at: "2026-10-01T00:00:00Z" })]]);
    setDefaultResolutionsSource(source);
    renderPage();
    await screen.findByRole("list", { name: "Changes from other devices" });
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Load older changes" }));
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));
    expect(screen.queryByRole("button", { name: "Load older changes" })).toBeNull();
  });

  it("an empty log has an empty state; a failed load offers a retry", async () => {
    setDefaultResolutionsSource(fakeSource([[]]));
    const { unmount } = renderPage();
    expect(await screen.findByText(/No automatic decisions yet/)).toBeInTheDocument();
    unmount();
    setDefaultResolutionsSource(fakeSource([[]], { page: async () => { throw new Error("x"); } }));
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent(/Could not load the changes/);
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});
