import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";

import { ApiError, notesApi, projectsApi, searchApi, tasksApi } from "../api/client";
import { makeProject, makeTask } from "../test/tasks";
import { CommandPalette } from "./CommandPalette";

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return {
    ApiError: actual.ApiError,
    searchApi: { search: vi.fn() },
    tasksApi: { get: vi.fn(), create: vi.fn() },
    notesApi: { create: vi.fn(), openDaily: vi.fn() },
    projectsApi: { create: vi.fn() },
  };
});

const RESULTS = {
  query: "zeb",
  notes: [{ id: "n1", path: "zoo/Zebra plan.md", title: "Zebra plan" }],
  tasks: [
    {
      id: "t1",
      title: "Feed the zebra",
      status: "next",
      priority: "none",
      due_at: null,
      project_id: null,
    },
  ],
  projects: [{ id: "p1", name: "Zebra crossing", status: "active" }],
};

function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.pathname + location.search}</output>;
}

function setup() {
  const props = { onClose: vi.fn(), onOpenTask: vi.fn(), onShowShortcuts: vi.fn() };
  render(
    <MemoryRouter initialEntries={["/inbox"]}>
      <CommandPalette {...props} />
      <Where />
    </MemoryRouter>,
  );
  return { ...props, box: screen.getByRole("combobox") };
}

function type(box: HTMLElement, value: string) {
  fireEvent.change(box, { target: { value } });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(searchApi.search).mockResolvedValue(RESULTS);
  vi.mocked(notesApi.openDaily).mockResolvedValue({ id: "d1" } as never);
  document.documentElement.removeAttribute("data-theme");
});

describe("CommandPalette", () => {
  it("is a modal combobox over a listbox with grouped options, focused on open", async () => {
    const { box } = setup();
    expect(screen.getByRole("dialog", { name: "Command palette" })).toHaveAttribute("aria-modal", "true");
    expect(box).toHaveFocus();
    expect(box).toHaveAttribute("aria-controls", screen.getByRole("listbox").id);

    type(box, "zeb");
    expect(await screen.findByRole("option", { name: /Zebra plan/ })).toBeInTheDocument();
    for (const group of ["Notes", "Tasks", "Projects"]) {
      expect(screen.getByRole("group", { name: group })).toBeInTheDocument();
    }
    expect(searchApi.search).toHaveBeenCalledWith("zeb", expect.objectContaining({ limit: 6 }));
    // The first match is active and announced through aria-activedescendant.
    const first = screen.getAllByRole("option")[0];
    expect(first).toHaveAttribute("aria-selected", "true");
    expect(box).toHaveAttribute("aria-activedescendant", first.id);
  });

  it("moves with the arrows (wrapping) and Tab keeps focus inside", async () => {
    const { box } = setup();
    type(box, "zeb");
    await screen.findByRole("option", { name: /Zebra plan/ });
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: /Feed the zebra/ })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(box, { key: "ArrowUp" });
    fireEvent.keyDown(box, { key: "ArrowUp" });
    const options = screen.getAllByRole("option");
    expect(options[options.length - 1]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(box, { key: "Tab" });
    expect(box).toHaveFocus();
  });

  it.each([
    ["a note", "zeb", /Zebra plan/, "/notes?open=n1"],
    ["a project", "zeb", /Zebra crossing/, "/projects/p1"],
    ["a view", "notes", /Go to Notes/, "/notes"],
    ["today's note", "today", /Open today's note/, "/notes?open=d1"],
    ["the template picker", "template", /New note from template/, "/notes?new=template"],
  ])("opens %s with Enter and closes", async (_name, text, option, path) => {
    const { box, onClose } = setup();
    type(box, text);
    const target = await screen.findByRole("option", { name: option });
    fireEvent.mouseMove(target);
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(path));
    expect(onClose).toHaveBeenCalled();
  });

  it("opens a task in the task detail after reading it", async () => {
    const task = makeTask({ id: "t1", title: "Feed the zebra" });
    vi.mocked(tasksApi.get).mockResolvedValue(task);
    const { box, onOpenTask, onClose } = setup();
    type(box, "zeb");
    fireEvent.click(await screen.findByRole("option", { name: /Feed the zebra/ }));
    await waitFor(() => expect(onOpenTask).toHaveBeenCalledWith(task));
    expect(tasksApi.get).toHaveBeenCalledWith("t1");
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on Escape, without ever running a create entry on Enter alone", async () => {
    vi.mocked(searchApi.search).mockResolvedValue({ query: "qqq", notes: [], tasks: [], projects: [] });
    const { box, onClose } = setup();
    type(box, "qqq");
    await screen.findByRole("option", { name: /New task/ });
    expect(screen.getAllByRole("option").every((o) => o.getAttribute("aria-selected") === "false")).toBe(true);
    fireEvent.keyDown(box, { key: "Enter" });
    expect(tasksApi.create).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("toggles the theme from a command", () => {
    const { box, onClose } = setup();
    type(box, "toggle");
    fireEvent.click(screen.getByRole("option", { name: /Toggle theme/ }));
    expect(document.documentElement.dataset.theme).toMatch(/^(light|dark)$/);
    expect(onClose).toHaveBeenCalled();
  });

  it.each([
    [
      "task",
      /New task/,
      () => vi.mocked(tasksApi.create).mockResolvedValue(makeTask({ id: "t9" })),
      () => expect(tasksApi.create).toHaveBeenCalledWith("Brand new"),
      "/inbox",
    ],
    [
      "note",
      /New note/,
      () => vi.mocked(notesApi.create).mockResolvedValue({ id: "n9" } as never),
      () => expect(notesApi.create).toHaveBeenCalledWith("Brand new", "# Brand new\n"),
      "/notes?open=n9",
    ],
    [
      "project",
      /New project/,
      () => vi.mocked(projectsApi.create).mockResolvedValue(makeProject({ id: "p9" })),
      () => expect(projectsApi.create).toHaveBeenCalledWith("Brand new"),
      "/projects/p9",
    ],
  ])("creates a %s from the typed text", async (_name, option, arrange, assertCall, path) => {
    arrange();
    const { box, onClose } = setup();
    type(box, "Brand new");
    fireEvent.click(await screen.findByRole("option", { name: option }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    assertCall();
    expect(screen.getByTestId("where")).toHaveTextContent(path);
  });

  it("shows a server error verbatim and stays open", async () => {
    vi.mocked(notesApi.create).mockRejectedValue(new ApiError(400, "Path must not contain '..'"));
    const { box, onClose } = setup();
    type(box, "../evil");
    fireEvent.click(await screen.findByRole("option", { name: /New note/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Path must not contain '..'");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows a search error verbatim", async () => {
    vi.mocked(searchApi.search).mockRejectedValue(new ApiError(422, "q: too long"));
    const { box } = setup();
    type(box, "zeb");
    expect(await screen.findByRole("alert")).toHaveTextContent("q: too long");
  });
});
