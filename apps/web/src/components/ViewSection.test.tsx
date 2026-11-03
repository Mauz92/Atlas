import { render, screen } from "@testing-library/react";

import { ViewSection } from "./ViewSection";

describe("ViewSection", () => {
  it("keeps the h2 as the section's first child and its accessible name equal to the title", () => {
    render(
      <ViewSection title="Overdue" tone="overdue" count={6}>
        <p>rows</p>
      </ViewSection>,
    );
    const heading = screen.getByRole("heading", { name: "Overdue" });
    expect(heading.parentElement?.tagName).toBe("SECTION");
    expect(heading.parentElement?.firstElementChild).toBe(heading);
    expect(heading).toHaveClass("section-head");
    // The count is visible to sighted users and hidden from the name.
    expect(heading.querySelector(".section-count")).toHaveTextContent("6");
    expect(heading.querySelector(".section-count")).toHaveAttribute("aria-hidden", "true");
  });

  it("gives Overdue and Due today an icon besides the colour class", () => {
    const { rerender } = render(<ViewSection title="Overdue" tone="overdue">x</ViewSection>);
    expect(screen.getByRole("heading").querySelector("svg.icon")).not.toBeNull();
    rerender(<ViewSection title="Due today" tone="today">x</ViewSection>);
    expect(screen.getByRole("heading").querySelector("svg.icon")).not.toBeNull();
    expect(screen.getByRole("heading").parentElement).toHaveClass("tone-today");
    rerender(<ViewSection title="Later">x</ViewSection>);
    expect(screen.getByRole("heading").querySelector("svg.icon")).toBeNull();
  });

  it("makes a labelled section a region", () => {
    render(<ViewSection title="Events" label="Events">x</ViewSection>);
    expect(screen.getByRole("region", { name: "Events" })).toBeInTheDocument();
  });
});
