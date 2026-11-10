import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ApiError, notesApi, type NoteDetail, type NoteSummary } from "../api/client";
import { NoteConflicts } from "./NoteConflicts";

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return { ...actual, notesApi: { get: vi.fn(), update: vi.fn(), remove: vi.fn() } };
});

const summary = (id: string, path: string) => ({ id, path, title: path }) as NoteSummary;
const detail = (id: string, path: string, content: string, revision = 3) => ({ id, path, title: path, content, revision }) as NoteDetail;

const NOTES = [summary("n1", "Plan.md"), summary("c1", "Plan (conflict 2026-11-10 093015).md")];

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(notesApi.get).mockImplementation(async (id: string) =>
    id === "n1" ? detail("n1", "Plan.md", "line one\nserver line\n") : detail("c1", "Plan (conflict 2026-11-10 093015).md", "line one\nmy line\n", 1),
  );
  vi.mocked(notesApi.update).mockResolvedValue(detail("n1", "Plan.md", "x"));
  vi.mocked(notesApi.remove).mockResolvedValue(undefined);
});

async function openResolver(onChanged = vi.fn()) {
  render(<NoteConflicts notes={NOTES} onChanged={onChanged} onOpen={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Resolve Plan (conflict 2026-11-10 093015).md" }));
  await screen.findByRole("heading", { name: "Two versions of this note" });
  return onChanged;
}

describe("NoteConflicts", () => {
  it("renders nothing without conflict copies", () => {
    const { container } = render(<NoteConflicts notes={[summary("n1", "Plan.md")]} onChanged={() => {}} onOpen={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lists the pair and shows a diff with text alternatives for screen readers", async () => {
    await openResolver();
    const diff = screen.getByRole("group", { name: "Differences, theirs to mine" });
    expect(diff).toHaveTextContent("Only in theirs: server line");
    expect(diff).toHaveTextContent("Only in mine: my line");
    expect(screen.getByText(/2 lines differ/)).toBeInTheDocument();
  });

  it("Keep mine writes the copy's text into the original with its revision, then deletes the copy (in that order)", async () => {
    const calls: string[] = [];
    vi.mocked(notesApi.update).mockImplementation(async (id: string) => { calls.push(`update ${id}`); return detail("n1", "Plan.md", "x"); });
    vi.mocked(notesApi.remove).mockImplementation(async (id: string) => { calls.push(`remove ${id}`); });
    const onChanged = await openResolver();
    fireEvent.click(screen.getByRole("button", { name: "Keep mine" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(notesApi.update).toHaveBeenCalledWith("n1", "line one\nmy line\n", 3);
    expect(calls).toEqual(["update n1", "remove c1"]);
    expect(screen.getByRole("status")).toHaveTextContent(/Your version is now the note/);
  });

  it("Keep theirs only deletes the copy; the original is not written", async () => {
    await openResolver();
    fireEvent.click(screen.getByRole("button", { name: "Keep theirs" }));
    await waitFor(() => expect(notesApi.remove).toHaveBeenCalledWith("c1"));
    expect(notesApi.update).not.toHaveBeenCalled();
  });

  it("Merge in the editor saves the merged text", async () => {
    await openResolver();
    fireEvent.click(screen.getByRole("button", { name: "Merge in the editor" }));
    fireEvent.change(screen.getByLabelText("Merged note text"), { target: { value: "line one\nboth lines\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save merged note" }));
    await waitFor(() => expect(notesApi.update).toHaveBeenCalledWith("n1", "line one\nboth lines\n", 3));
    expect(notesApi.remove).toHaveBeenCalledWith("c1");
  });

  it("a 409 on the original deletes nothing, rereads the note and says so", async () => {
    vi.mocked(notesApi.update).mockRejectedValue(new ApiError(409, "conflict"));
    await openResolver();
    fireEvent.click(screen.getByRole("button", { name: "Keep mine" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/nothing was overwritten or deleted/);
    expect(notesApi.remove).not.toHaveBeenCalled();
  });

  it("a failed delete after a saved original keeps the copy and says nothing was deleted", async () => {
    vi.mocked(notesApi.remove).mockRejectedValue(new ApiError(500, "boom"));
    await openResolver();
    fireEvent.click(screen.getByRole("button", { name: "Keep mine" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Nothing was lost/);
  });

  it("a copy whose original is gone can be opened instead", () => {
    const onOpen = vi.fn();
    render(<NoteConflicts notes={[summary("c1", "Lost (conflict 2026-11-10 093015).md")]} onChanged={() => {}} onOpen={onOpen} />);
    expect(screen.getByText("The original is gone.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open Lost (conflict 2026-11-10 093015).md" }));
    expect(onOpen).toHaveBeenCalledWith("c1");
  });
});
