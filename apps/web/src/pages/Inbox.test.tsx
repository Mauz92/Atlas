import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { tasksApi } from "../api/client";
import { makeTask } from "../test/tasks";
import { Inbox } from "./Inbox";

vi.mock("../api/client", () => ({
  tasksApi: { list: vi.fn(), create: vi.fn(), complete: vi.fn() },
}));

const listMock = vi.mocked(tasksApi.list);
const createMock = vi.mocked(tasksApi.create);

beforeEach(() => {
  vi.resetAllMocks();
});

describe("Inbox", () => {
  it("renders the inbox tasks returned by the API", async () => {
    listMock.mockResolvedValue({
      tasks: [
        makeTask({ id: "a", title: "Call the vet" }),
        makeTask({ id: "b", title: "Book flights", priority: "high" }),
      ],
    });

    render(<Inbox />);

    expect(await screen.findByText("Call the vet")).toBeInTheDocument();
    expect(screen.getByText("Book flights")).toBeInTheDocument();
    expect(listMock).toHaveBeenCalledWith(expect.objectContaining({ view: "inbox" }));
  });

  it("shows a useful empty state", async () => {
    listMock.mockResolvedValue({ tasks: [] });

    render(<Inbox />);

    expect(await screen.findByText(/Inbox zero/i)).toBeInTheDocument();
  });

  it("shows a clear error when loading fails", async () => {
    listMock.mockRejectedValueOnce(new Error("Bad gateway"));

    render(<Inbox />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Bad gateway");
  });

  it("quick-captures a task with a title only", async () => {
    listMock.mockResolvedValue({ tasks: [] });
    createMock.mockResolvedValue(makeTask({ id: "new", title: "Water plants" }));

    render(<Inbox />);
    await screen.findByText(/Inbox zero/i);

    fireEvent.change(screen.getByLabelText("Task title"), { target: { value: "Water plants" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(createMock).toHaveBeenCalledWith("Water plants"));
    expect(listMock).toHaveBeenCalledTimes(2);
  });
});
