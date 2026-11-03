import { render, screen } from "@testing-library/react";

import { EmptyState } from "./EmptyState";
import { Skeleton } from "./Skeleton";

describe("Skeleton", () => {
  it("is the page's status with screen-reader text, and its bars are hidden from assistive tech", () => {
    const { container } = render(<Skeleton label="Loading inbox" rows={4} />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Loading inbox…");
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(container.querySelectorAll(".skeleton-row")).toHaveLength(4);
    expect(container.querySelectorAll('.skeleton-row[aria-hidden="true"]')).toHaveLength(4);
  });

  it("draws heading bars for groups and columns for a board", () => {
    const grouped = render(<Skeleton label="Loading today" rows={2} groups={3} />);
    expect(grouped.container.querySelectorAll(".skeleton-group")).toHaveLength(3);
    expect(grouped.container.querySelectorAll(".skeleton-row")).toHaveLength(6);
    grouped.unmount();
    const board = render(<Skeleton label="Loading board" kind="board" />);
    expect(board.container.querySelectorAll(".skeleton-column")).toHaveLength(4);
  });
});

describe("EmptyState", () => {
  it("shows an icon, one line and an optional single action", () => {
    const onClick = vi.fn();
    const { container } = render(
      <EmptyState icon="inbox" action={{ label: "Do it", onClick }}>
        Nothing here.
      </EmptyState>,
    );
    expect(screen.getByText("Nothing here.")).toBeInTheDocument();
    expect(container.querySelector("svg.icon")).toHaveAttribute("aria-hidden", "true");
    screen.getByRole("button", { name: "Do it" }).click();
    expect(onClick).toHaveBeenCalledTimes(1);
    // Not a status: pages own that role.
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("renders no button without an action", () => {
    render(<EmptyState icon="sun">Quiet.</EmptyState>);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
