import { keyboardInset } from "./keyboardInset";

describe("keyboardInset", () => {
  it("is 0 without a visual viewport", () => {
    expect(keyboardInset(800, null)).toBe(0);
    expect(keyboardInset(800, undefined)).toBe(0);
  });

  it("is the part of the window the visual viewport no longer covers (iOS keyboard)", () => {
    expect(keyboardInset(800, { height: 500, offsetTop: 0 })).toBe(300);
    // The page was scrolled inside the visual viewport: the bottom edge is height + offsetTop.
    expect(keyboardInset(800, { height: 500, offsetTop: 40 })).toBe(260);
  });

  it("is 0 when the layout viewport already shrank (resizes-content) or the values are odd", () => {
    expect(keyboardInset(500, { height: 500, offsetTop: 0 })).toBe(0);
    expect(keyboardInset(500, { height: 520, offsetTop: 0 })).toBe(0);
    expect(keyboardInset(Number.NaN, { height: 500, offsetTop: 0 })).toBe(0);
  });
});
