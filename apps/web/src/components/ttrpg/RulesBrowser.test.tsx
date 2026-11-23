import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { SRD_ATTRIBUTION } from "../../lib/srdRules";
import { RulesBrowser } from "./RulesBrowser";
import { RulesPage } from "./RulesPage";

describe("RulesBrowser", () => {
  it("lists the groups collapsed, with the licence notice", () => {
    render(<RulesBrowser />);
    for (const group of ["Conditions", "Turn and round", "Actions in combat", "Attacks", "Movement", "Damage and healing", "Resting"]) {
      expect(screen.getByRole("region", { name: group })).toBeInTheDocument();
    }
    const prone = screen.getByText("Prone").closest("details")!;
    expect(prone.open).toBe(false);
    expect(screen.getByText(SRD_ATTRIBUTION)).toBeInTheDocument();
  });

  it("opens and closes an entry", () => {
    render(<RulesBrowser />);
    const prone = screen.getByText("Prone").closest("details")!;
    fireEvent.click(screen.getByText("Prone"));
    prone.open = true;
    fireEvent(prone, new Event("toggle"));
    expect(within(prone).getByText(/only movement option is to crawl/)).toBeInTheDocument();
  });

  it("filters while typing, opens the matches and says when nothing matches", () => {
    render(<RulesBrowser />);
    fireEvent.change(screen.getByLabelText("Search the rules"), { target: { value: "three-quarters" } });
    const cover = screen.getByText("Cover").closest("details")!;
    expect(cover.open).toBe(true);
    expect(screen.queryByText("Blinded")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search the rules"), { target: { value: "qqqzzz" } });
    expect(screen.getByText(/Nothing in these rules matches/)).toBeInTheDocument();
  });

  it("opens the focused entry (a condition chip or ?rule=)", async () => {
    render(<RulesBrowser focusId="poisoned" />);
    await waitFor(() => expect(screen.getByText("Poisoned").closest("details")!.open).toBe(true));
    expect(screen.getByText(/disadvantage on attack rolls and ability checks/)).toBeInTheDocument();
  });

  it("renders rule text as text, never as markup", () => {
    const { container } = render(<RulesBrowser />);
    expect(container.querySelector("script, img, iframe")).toBeNull();
  });
});

describe("RulesPage", () => {
  it("opens the entry named in the link", async () => {
    render(
      <MemoryRouter initialEntries={["/ttrpg/rules?rule=prone"]}>
        <Routes>
          <Route path="/ttrpg/rules" element={<RulesPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { name: "Rules reference", level: 1 })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Prone").closest("details")!.open).toBe(true));
  });
});
