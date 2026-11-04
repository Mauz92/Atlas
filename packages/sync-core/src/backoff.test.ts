import { backoffDelay, DEFAULT_BACKOFF, parseRetryAfter } from "./backoff.ts";

describe("backoff", () => {
  it("is bounded by the ceiling and grows exponentially", () => {
    const max = { next: () => 0.999999 };
    expect(backoffDelay(1, max, DEFAULT_BACKOFF)).toBeLessThanOrEqual(2000);
    expect(backoffDelay(2, max, DEFAULT_BACKOFF)).toBeLessThanOrEqual(4000);
    expect(backoffDelay(3, max, DEFAULT_BACKOFF)).toBeGreaterThan(4000);
    expect(backoffDelay(50, max, DEFAULT_BACKOFF)).toBeLessThanOrEqual(300_000);
  });
  it("uses full jitter down to zero", () => {
    expect(backoffDelay(5, { next: () => 0 }, DEFAULT_BACKOFF)).toBe(0);
  });
  it("parses Retry-After as seconds or a date, and ignores junk", () => {
    expect(parseRetryAfter("7", 0)).toBe(7000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfter("soon", 0)).toBeNull();
    expect(parseRetryAfter(undefined, 0)).toBeNull();
  });
});
