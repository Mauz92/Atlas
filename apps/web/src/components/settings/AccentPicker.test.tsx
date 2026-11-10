import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { ACCENT_STORAGE_KEY, ACCENTS, HEADINGS_STORAGE_KEY } from "../../lib/accent";
import { AppearanceSection } from "./AppearanceSection";

const root = document.documentElement;

beforeEach(() => {
  localStorage.clear();
  localStorage.removeItem(HEADINGS_STORAGE_KEY);
  delete root.dataset.accent;
  delete root.dataset.accentText;
});

function group() {
  return screen.getByRole("radiogroup", { name: "Accent colour" });
}

describe("accent picker in Settings -> Appearance (UX-12)", () => {
  it("is a radio group with one named radio per accent, Neutral checked and labelled as the default", () => {
    render(<AppearanceSection />);
    const radios = within(group()).getAllByRole("radio");
    expect(radios).toHaveLength(ACCENTS.length);
    for (const { label } of ACCENTS) {
      expect(within(group()).getByRole("radio", { name: new RegExp(`^${label}`) })).toBeInTheDocument();
    }
    const neutral = within(group()).getByRole("radio", { name: "Neutral (default)" });
    expect(neutral).toBeChecked();
    expect(radios.filter((radio) => (radio as HTMLInputElement).checked)).toHaveLength(1);
  });

  it("keeps the theme group unchanged and does not clash with its radio names", () => {
    render(<AppearanceSection />);
    expect(screen.getByRole("radiogroup", { name: "Theme" })).toBeInTheDocument();
    for (const name of ["System", "Light", "Dark"]) {
      expect(screen.getAllByRole("radio", { name })).toHaveLength(1);
    }
  });

  it("applies a choice at once and remembers it", () => {
    render(<AppearanceSection />);
    fireEvent.click(within(group()).getByRole("radio", { name: "Violet" }));
    expect(root.dataset.accent).toBe("violet");
    expect(localStorage.getItem(ACCENT_STORAGE_KEY)).toBe("violet");
    expect(within(group()).getByRole("radio", { name: "Violet" })).toBeChecked();
    expect(within(group()).getByRole("radio", { name: "Neutral (default)" })).not.toBeChecked();

    fireEvent.click(within(group()).getByRole("radio", { name: "Neutral (default)" }));
    expect(root.dataset.accent).toBeUndefined();
    expect(localStorage.getItem(ACCENT_STORAGE_KEY)).toBeNull();
  });

  it("shows the stored accent as checked when it opens", () => {
    localStorage.setItem(ACCENT_STORAGE_KEY, "green");
    render(<AppearanceSection />);
    expect(within(group()).getByRole("radio", { name: "Green" })).toBeChecked();
  });

  it("follows a change made elsewhere (another tab)", () => {
    render(<AppearanceSection />);
    localStorage.setItem(ACCENT_STORAGE_KEY, "teal");
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: ACCENT_STORAGE_KEY }));
    });
    expect(within(group()).getByRole("radio", { name: "Teal" })).toBeChecked();
    expect(root.dataset.accent).toBe("teal");
  });

  it("uses native radios in one group, so Tab and the arrow keys work as in any radio group", () => {
    render(<AppearanceSection />);
    const radios = within(group()).getAllByRole("radio") as HTMLInputElement[];
    expect(new Set(radios.map((radio) => radio.name))).toEqual(new Set(["accent"]));
    for (const radio of radios) {
      expect(radio.type).toBe("radio");
      expect(radio.disabled).toBe(false);
      expect(radio.tabIndex).toBeGreaterThanOrEqual(0);
    }
    // Arrow-key movement itself is exercised in the browser (e2e-real/ux12-accent.spec.ts).
  });

  it("marks the selected swatch with a check mark that is hidden from assistive technology", () => {
    render(<AppearanceSection />);
    const radio = within(group()).getByRole("radio", { name: "Neutral (default)" });
    const check = radio.parentElement!.querySelector(".accent-check");
    expect(check).toHaveAttribute("aria-hidden", "true");
    expect(check!.querySelector("svg")).not.toBeNull();
  });

  it("has a 'Colour headings with the accent' switch, on by default, with a heading preview", () => {
    render(<AppearanceSection />);
    const toggle = screen.getByRole("switch", { name: "Colour headings with the accent" });
    expect(toggle).toBeChecked();
    expect(screen.getByTestId("accent-heading-sample")).toHaveTextContent("Heading preview");
    expect(screen.getByText(/Nothing changes while the accent is Neutral/)).toBeInTheDocument();
    expect(root.dataset.accentText).toBeUndefined();

    fireEvent.click(within(group()).getByRole("radio", { name: "Blue" }));
    expect(root.dataset.accentText).toBe("on");
    expect(screen.queryByText(/Nothing changes while the accent is Neutral/)).toBeNull();

    fireEvent.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(localStorage.getItem(HEADINGS_STORAGE_KEY)).toBe("off");
    expect(root.dataset.accentText).toBeUndefined();
    fireEvent.click(toggle);
    expect(root.dataset.accentText).toBe("on");
  });
});
