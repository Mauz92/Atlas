import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { makeProject } from "../test/tasks";
import { ProjectForm } from "./ProjectForm";

describe("ProjectForm", () => {
  it("submits the trimmed name and null for empty optional fields, then clears when creating", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<ProjectForm submitLabel="Create project" onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText("Project name"), {
      target: { value: "  Garden  " },
    });
    fireEvent.change(screen.getByLabelText("Target date"), {
      target: { value: "2026-12-01" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith("Garden", {
        description: null,
        start_date: null,
        target_date: "2026-12-01",
      }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Project name")).toHaveValue(""),
    );
  });

  it("shows the server's message verbatim and keeps what was typed; edit prefills", async () => {
    const onSubmit = vi
      .fn()
      .mockRejectedValue(new Error("target_date: must not precede start_date"));
    render(
      <ProjectForm
        project={makeProject({ name: "Home", description: "Fix things" })}
        submitLabel="Save project"
        onSubmit={onSubmit}
      />,
    );
    expect(screen.getByLabelText("Project name")).toHaveValue("Home");
    expect(screen.getByLabelText("Project description")).toHaveValue(
      "Fix things",
    );

    fireEvent.click(screen.getByRole("button", { name: "Save project" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "target_date: must not precede start_date",
    );
    expect(screen.getByLabelText("Project name")).toHaveValue("Home");
  });
});
