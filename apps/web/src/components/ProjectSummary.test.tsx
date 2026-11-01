import { render, screen } from "@testing-library/react";

import { makeProject } from "../test/tasks";
import { ProjectSummary } from "./ProjectSummary";

describe("ProjectSummary", () => {
  it("renders nothing when the plan touches no project", () => {
    const { container } = render(<ProjectSummary projects={[]} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("names each project with its derived progress", () => {
    render(
      <ProjectSummary
        projects={[
          makeProject({ id: "p1", name: "Atlas launch", progress: { total: 5, completed: 3, percent: 60 } }),
          makeProject({ id: "p2", name: "Home", progress: { total: 0, completed: 0, percent: 0 } }),
        ]}
      />,
    );

    expect(screen.getByText("Atlas launch")).toBeInTheDocument();
    expect(screen.getByText("3/5 · 60%")).toBeInTheDocument();
    // A project with no countable tasks is never shown as complete.
    expect(screen.getByText("0/0 · 0%")).toBeInTheDocument();
  });
});
