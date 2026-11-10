/**
 * The API base URL rule of the desktop client (SYNC_PROTOCOL 10.1): HTTPS, except a loopback host
 * (a throwaway server used by tests and by a developer). Only an origin: no credentials, no path,
 * no query, no fragment. The Rust host applies the same rule again; this copy gives early feedback.
 */
export type BaseUrlCheck = { ok: true; baseUrl: string } | { ok: false; failure: "insecure_url"; detail: string };

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function checkBaseUrl(input: string): BaseUrlCheck {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { ok: false, failure: "insecure_url", detail: "not a valid URL" };
  }
  const loopback = LOOPBACK.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    return { ok: false, failure: "insecure_url", detail: "the server address must start with https:// (http:// is only allowed for localhost)" };
  if (url.username || url.password) return { ok: false, failure: "insecure_url", detail: "the address must not contain a user name or password" };
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash)
    return { ok: false, failure: "insecure_url", detail: "give the address of the server only, for example https://atlas.example.org" };
  return { ok: true, baseUrl: url.origin };
}
