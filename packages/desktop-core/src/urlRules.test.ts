import { checkBaseUrl } from "./urlRules.ts";

describe("API base URL rule", () => {
  it.each([
    ["https://atlas.example.org", "https://atlas.example.org"],
    ["https://atlas.example.org/", "https://atlas.example.org"],
    ["http://localhost:8000", "http://localhost:8000"],
    ["http://127.0.0.1:18000/", "http://127.0.0.1:18000"],
    ["http://[::1]:8000", "http://[::1]:8000"],
  ])("accepts %s", (input, out) => expect(checkBaseUrl(input)).toEqual({ ok: true, baseUrl: out }));
  it.each([
    "http://atlas.example.org",
    "http://192.168.1.5:8000",
    "ftp://atlas.example.org",
    "https://user:pw@atlas.example.org",
    "https://atlas.example.org/api",
    "https://atlas.example.org/?x=1",
    "atlas.example.org",
    "http://localhost.evil.example",
  ])("refuses %s", (input) => expect(checkBaseUrl(input).ok).toBe(false));
});
