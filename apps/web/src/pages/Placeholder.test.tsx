import { render, screen } from "@testing-library/react";

import { Placeholder } from "./Placeholder";

describe("Placeholder", () => {
  it("renders the title and description", () => {
    render(<Placeholder title="Today" description="Your day at a glance." />);
    expect(screen.getByRole("heading", { name: "Today" })).toBeInTheDocument();
    expect(screen.getByText("Your day at a glance.")).toBeInTheDocument();
  });
});
