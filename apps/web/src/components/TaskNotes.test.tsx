import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { tasksApi, type NoteSummary } from "../api/client";
import { TaskNotes } from "./TaskNotes";

vi.mock("../api/client", () => ({
  tasksApi: { notes: vi.fn(), unlinkNote: vi.fn() },
}));

const note = (id: string, path: string, title: string): NoteSummary => ({
  id,
  path,
  title,
  revision: 1,
  content_hash: "h",
  size_bytes: 1,
});
const plan = note("n1", "Projects/Plan.md", "Plan");

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(tasksApi.notes).mockResolvedValue({ notes: [plan] });
});

describe("TaskNotes", () => {
  it("lists linked notes by title and path and opens one", async () => {
    const onOpen = vi.fn();
    render(<TaskNotes taskId="t1" onOpen={onOpen} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open note Projects/Plan.md" }));
    expect(screen.getByText("Plan")).toBeInTheDocument();
    expect(onOpen).toHaveBeenCalledWith("n1");
    expect(tasksApi.notes).toHaveBeenCalledWith("t1");
  });

  it("cannot open a note while the task has unsaved edits", async () => {
    render(<TaskNotes taskId="t1" onOpen={vi.fn()} openDisabled />);
    expect(await screen.findByRole("button", { name: /Open note/ })).toBeDisabled();
  });

  it("unlinks and reloads, showing how to link when none are left", async () => {
    vi.mocked(tasksApi.unlinkNote).mockResolvedValue(undefined);
    render(<TaskNotes taskId="t1" onOpen={vi.fn()} />);
    vi.mocked(tasksApi.notes).mockResolvedValue({ notes: [] });
    fireEvent.click(await screen.findByRole("button", { name: "Unlink note Projects/Plan.md" }));
    await waitFor(() => expect(tasksApi.unlinkNote).toHaveBeenCalledWith("t1", "n1"));
    expect(await screen.findByText(/No linked notes/)).toBeInTheDocument();
  });

  it("shows the server's message when loading fails", async () => {
    vi.mocked(tasksApi.notes).mockRejectedValue(new Error("Not found"));
    render(<TaskNotes taskId="t1" onOpen={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Not found");
  });
});
