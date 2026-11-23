import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { featuresApi } from "../api/client";
import { PluginsSection } from "../components/settings/PluginsSection";
import { navSectionsFor, NAV_SECTIONS } from "./navigation";
import { Ttrpg } from "../pages/Ttrpg";
import { resetFeatures } from "./features";

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return { ...actual, featuresApi: { get: vi.fn(), set: vi.fn() },
    ttrpgApi: { campaigns: vi.fn().mockResolvedValue({ items: [] }) },
  };
});

const get = vi.mocked(featuresApi.get);
const set = vi.mocked(featuresApi.set);

beforeEach(() => {
  resetFeatures();
  get.mockReset();
  set.mockReset();
});

describe("optional features (TTRPG-01)", () => {
  it("is off by default in the navigation", () => {
    expect(navSectionsFor({ ttrpg: false })).toBe(NAV_SECTIONS);
    const on = navSectionsFor({ ttrpg: true });
    // TTRPG is a category of its own, right after Workspace, with Campaigns, Creatures and Rules
    expect(on.map((section) => section.id)).toEqual(["planning", "workspace", "ttrpg", "more"]);
    expect(on.find((section) => section.id === "ttrpg")).toMatchObject({ label: "TTRPG" });
    expect(on.find((section) => section.id === "ttrpg")!.items.map((item) => item.label)).toEqual(["Campaigns", "Creatures", "Rules"]);
    expect(on.find((section) => section.id === "workspace")!.items.map((item) => item.to)).not.toContain("/ttrpg");
    expect(on.flatMap((section) => section.items).map((item) => item.to)).toContain("/ttrpg");
    expect(on.flatMap((section) => section.items).map((item) => item.to)).toContain("/ttrpg/rules");
    expect(NAV_SECTIONS.flatMap((section) => section.items).map((item) => item.to)).not.toContain("/ttrpg");
    expect(NAV_SECTIONS.flatMap((section) => section.items).map((item) => item.to)).not.toContain("/ttrpg/rules");
  });

  it("the route shows only how to enable it while the module is off", async () => {
    get.mockResolvedValue({ ttrpg: false });
    render(
      <MemoryRouter>
        <Ttrpg />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/This module is off/)).toBeInTheDocument();
    expect(screen.queryByText(/No campaigns yet/)).not.toBeInTheDocument();
  });

  it("treats a failed load as off", async () => {
    get.mockRejectedValue(new Error("boom"));
    render(
      <MemoryRouter>
        <Ttrpg />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/This module is off/)).toBeInTheDocument();
  });

  it("the Plugins switch enables the module, and shows the server's refusal", async () => {
    get.mockResolvedValue({ ttrpg: false });
    set.mockResolvedValueOnce({ ttrpg: true });
    render(
      <MemoryRouter>
        <PluginsSection />
        <Ttrpg />
      </MemoryRouter>,
    );
    const toggle = await screen.findByRole("switch", { name: /TTRPG/ });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).not.toBeChecked();
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(set).toHaveBeenCalledWith("ttrpg", true);
    await waitFor(() => expect(toggle).toBeChecked());
    expect(screen.getByText(/No campaigns yet/)).toBeInTheDocument();

    set.mockRejectedValueOnce(new Error("nope"));
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(/nope/);
    expect(toggle).toBeChecked();
  });
});
