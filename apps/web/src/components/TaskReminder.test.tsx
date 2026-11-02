import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { notificationsApi } from "../api/client";
import { TaskReminder } from "./TaskReminder";

vi.mock("../api/client", () => ({
  notificationsApi: { taskReminder: vi.fn(), setTaskReminder: vi.fn() },
}));

const inheriting = {
  override: null,
  effective: { days_before: 0, at_time: "09:00" },
  remind_at: "2026-11-03T08:00:00Z",
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(notificationsApi.taskReminder).mockResolvedValue(inheriting);
});

describe("TaskReminder", () => {
  it("shows the timing in force and that it is the default", async () => {
    render(<TaskReminder taskId="t1" />);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "On the due day at 09:00 (your default)",
    );
    expect(screen.getByLabelText("Reminder timing for this task")).toHaveValue(
      "default",
    );
  });

  it.each([
    ["1d-9am", { days_before: 1, at_time: "09:00" }],
    ["default", null],
  ])("saves %s as the task's override", async (choice, timing) => {
    vi.mocked(notificationsApi.setTaskReminder).mockResolvedValue({
      override: timing,
      effective: timing,
      remind_at: null,
    });
    render(<TaskReminder taskId="t1" />);
    await screen.findByRole("status");
    const select = screen.getByLabelText("Reminder timing for this task");
    // Start from the other choice so the change is real.
    fireEvent.change(select, {
      target: { value: choice === "default" ? "1w-9am" : "default" },
    });
    fireEvent.change(select, { target: { value: choice } });
    fireEvent.click(screen.getByRole("button", { name: "Set reminder" }));
    await waitFor(() =>
      expect(notificationsApi.setTaskReminder).toHaveBeenCalledWith(
        "t1",
        timing,
      ),
    );
  });

  it("sends a custom timing as typed and shows the server's rejection verbatim", async () => {
    vi.mocked(notificationsApi.setTaskReminder).mockRejectedValue(
      new Error("days_before: Input should be less than or equal to 30"),
    );
    render(<TaskReminder taskId="t1" />);
    await screen.findByRole("status");
    fireEvent.change(screen.getByLabelText("Reminder timing for this task"), {
      target: { value: "custom" },
    });
    fireEvent.change(screen.getByLabelText("Days before"), {
      target: { value: "99" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set reminder" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "less than or equal to 30",
    );
    expect(notificationsApi.setTaskReminder).toHaveBeenCalledWith("t1", {
      days_before: 99,
      at_time: "09:00",
    });
  });
});
