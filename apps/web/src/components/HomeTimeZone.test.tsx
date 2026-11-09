import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { HomeTimeZone } from "./HomeTimeZone";

describe("HomeTimeZone", () => {
  it("shows the saved zone and offers 'Not set (UTC)'", () => {
    render(<HomeTimeZone zone="Europe/Amsterdam" onSave={() => {}} />);
    const select = screen.getByLabelText("Time zone for reminders") as HTMLSelectElement;
    expect(select.value).toBe("Europe/Amsterdam");
    expect(screen.getByRole("option", { name: "Not set (UTC)" })).toBeInTheDocument();
  });

  it("saves a chosen zone and clears with the unset option", () => {
    const onSave = vi.fn();
    render(<HomeTimeZone zone={null} onSave={onSave} />);
    const select = screen.getByLabelText("Time zone for reminders");
    fireEvent.change(select, { target: { value: "UTC" } });
    expect(onSave).toHaveBeenLastCalledWith("UTC");
    fireEvent.change(select, { target: { value: "" } });
    expect(onSave).toHaveBeenLastCalledWith(null);
  });

  it("shows loading, saved and error states", () => {
    const { rerender } = render(<HomeTimeZone zone={null} loading onSave={() => {}} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading time zone");
    rerender(<HomeTimeZone zone={null} saved error="Boom" onSave={() => {}} />);
    expect(screen.getByRole("status")).toHaveTextContent("Saved.");
    expect(screen.getByRole("alert")).toHaveTextContent("Boom");
  });

  it("disables the select while saving", () => {
    render(<HomeTimeZone zone={null} saving onSave={() => {}} />);
    expect(screen.getByLabelText("Time zone for reminders")).toBeDisabled();
  });
});
