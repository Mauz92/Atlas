import { act, render, screen } from "@testing-library/react";

describe("test environment", () => {
  // Regression guard for SUP-001: if NODE_ENV leaks in as "production", React resolves its
  // production build, which does not export `act`. @testing-library/react then falls back to
  // the deprecated react-dom/test-utils shim and every component test fails with the cryptic
  // "React.act is not a function". vite.config.ts pins NODE_ENV=test for the vitest run.
  it("exposes React.act so React 19 component tests can render", () => {
    expect(typeof act).toBe("function");
    render(<div data-testid="canary">ok</div>);
    expect(screen.getByTestId("canary")).toBeInTheDocument();
  });
});
