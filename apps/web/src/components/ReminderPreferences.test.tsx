import { fireEvent, render, screen } from "@testing-library/react";

import { ReminderPreferences } from "./ReminderPreferences";

const base = { onSave: vi.fn() };

describe("ReminderPreferences", () => {
  it("shows a loading state while the timing is read", () => {
    render(<ReminderPreferences {...base} timing={null} loading />);
    expect(screen.getByRole("status")).toHaveTextContent(/Loading reminder timing/i);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows the empty state and the presets when reminders are off", () => {
    render(<ReminderPreferences {...base} timing={null} />);
    expect(screen.getByRole("heading", { name: "Reminder timing" })).toBeInTheDocument();
    const select = screen.getByLabelText("Reminder timing");
    expect(select).toHaveValue("off");
    expect(screen.getByRole("option", { name: "No reminder" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "1 day before at 09:00" })).toBeInTheDocument();
    expect(screen.getByText(/Reminders are off/i)).toBeInTheDocument();
  });

  it("saves a chosen preset via the keyboard-accessible button", () => {
    const onSave = vi.fn();
    render(<ReminderPreferences {...base} onSave={onSave} timing={null} />);
    fireEvent.change(screen.getByLabelText("Reminder timing"), { target: { value: "1d-9am" } });
    fireEvent.click(screen.getByRole("button", { name: "Save reminder timing" }));
    expect(onSave).toHaveBeenCalledWith({ days_before: 1, at_time: "09:00" });
  });

  it("saves 'off' (null) to turn reminders off", () => {
    const onSave = vi.fn();
    render(
      <ReminderPreferences
        {...base}
        onSave={onSave}
        timing={{ days_before: 2, at_time: "09:00" }}
      />,
    );
    fireEvent.change(screen.getByLabelText("Reminder timing"), { target: { value: "off" } });
    fireEvent.click(screen.getByRole("button", { name: "Save reminder timing" }));
    expect(onSave).toHaveBeenCalledWith(null);
  });

  it("reveals custom fields and saves a valid custom timing", () => {
    const onSave = vi.fn();
    render(<ReminderPreferences {...base} onSave={onSave} timing={null} />);
    fireEvent.change(screen.getByLabelText("Reminder timing"), { target: { value: "custom" } });
    fireEvent.change(screen.getByLabelText("Days before"), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText("Time"), { target: { value: "07:45" } });
    fireEvent.click(screen.getByRole("button", { name: "Save reminder timing" }));
    expect(onSave).toHaveBeenCalledWith({ days_before: 3, at_time: "07:45" });
  });

  it("rejects an invalid custom timing without saving", () => {
    const onSave = vi.fn();
    render(<ReminderPreferences {...base} onSave={onSave} timing={null} />);
    fireEvent.change(screen.getByLabelText("Reminder timing"), { target: { value: "custom" } });
    fireEvent.change(screen.getByLabelText("Days before"), { target: { value: "99" } });
    fireEvent.click(screen.getByRole("button", { name: "Save reminder timing" }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/Days before must be a whole number/i);
  });

  it("shows a saved confirmation", () => {
    render(<ReminderPreferences {...base} timing={{ days_before: 1, at_time: "09:00" }} saved />);
    expect(screen.getByRole("status")).toHaveTextContent("Saved.");
  });

  it("disables the control and reports progress while saving", () => {
    render(<ReminderPreferences {...base} timing={null} saving />);
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(screen.getByLabelText("Reminder timing")).toBeDisabled();
  });

  it("surfaces a save error as an alert", () => {
    render(<ReminderPreferences {...base} timing={null} error="Could not save the reminder timing" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Could not save the reminder timing");
  });
});
