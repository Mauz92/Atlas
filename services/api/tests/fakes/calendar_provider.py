"""A local fake calendar provider (Google + Microsoft OAuth/API shapes + an ICS host).

Used instead of the internet by the calendar tests and the real-stack Playwright specs (AGENTS.md §11:
no real accounts or data in automated tests). It speaks the **documented** response shapes the
adapters consume:

- Google: OAuth 2.0 web-server flow (auth, token, revoke) - https://developers.google.com/identity/protocols/oauth2/web-server;
  ``calendarList.list`` and ``events.list`` incl. ``nextSyncToken`` / ``410 Gone`` -
  https://developers.google.com/workspace/calendar/api/guides/sync
- Microsoft: identity platform v2 auth-code + PKCE (authorize, token with refresh-token rotation) -
  https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow; Graph ``calendars``
  and ``calendarView/delta`` with ``@odata.nextLink`` / ``@odata.deltaLink`` / ``@removed`` -
  https://learn.microsoft.com/en-us/graph/api/event-delta
- ICS: ``/ics/<name>.ics`` with ``ETag`` / ``If-None-Match``.

It also enforces what the real providers enforce and the code under test must satisfy: the exact
registered redirect URI, a single-use authorisation code, PKCE ``S256``, the client secret, bearer
tokens that expire, and (via ``failures``) throttling and outages.

Run standalone for the browser specs: ``python -m tests.fakes.calendar_provider --port 9911``.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import itertools
import json
import secrets
import time
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlencode

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import (
    HTMLResponse,
    JSONResponse,
    PlainTextResponse,
    RedirectResponse,
    Response,
)
from starlette.routing import Route

CLIENT_ID = "fake-client-id"
CLIENT_SECRET = "fake-client-secret"
GOOGLE_SCOPE = "https://www.googleapis.com/auth/calendar.readonly"
MS_SCOPE = "offline_access Calendars.Read"


class FakeProvider:
    """All fake state, mutable from tests (in-process) or via ``POST /_control``."""

    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self._rev = itertools.count(1)
        self.codes: dict[str, dict[str, str]] = {}
        self.access_tokens: dict[str, float] = {}
        self.refresh_tokens: dict[str, str] = {}
        self.revoked: list[str] = []
        self.requests: list[tuple[str, str]] = []  # (method, path) of every provider call
        self.auth_requests: list[dict[str, str]] = []  # the query of every authorise request
        self.token_requests: list[dict[str, str]] = []
        self.deny_authorize = False
        self.expires_in = 3600
        self.issue_refresh_token = True
        self.granted_scope: str | None = None  # override the scope the token response claims
        self.failures: list[int] = []  # status codes to answer (and consume) on the next API calls
        self.retry_after: str | None = None
        self.invalidate_sync_tokens = False
        self.fail_refresh = False
        self.rev = 0
        self.google_calendars: list[dict[str, Any]] = [
            {
                "id": "owner@example.test",
                "summary": "Owner",
                "timeZone": "Europe/Berlin",
                "accessRole": "owner",
                "primary": True,
            },
            {
                "id": "holidays@group.v.calendar.example.test",
                "summary": "Holidays",
                "timeZone": "Europe/Berlin",
                "accessRole": "reader",
            },
        ]
        self.google_events: dict[str, list[dict[str, Any]]] = {
            c["id"]: [] for c in self.google_calendars
        }
        self.ms_calendars: list[dict[str, Any]] = [
            {"id": "AAMkAD-cal-1", "name": "Calendar", "isDefaultCalendar": True, "canEdit": True},
        ]
        self.ms_events: dict[str, list[dict[str, Any]]] = {c["id"]: [] for c in self.ms_calendars}
        self.ics: dict[str, dict[str, Any]] = {}
        self.page_size_cap = 0  # 0 = honour the client's page size
        self.last_prefer: str | None = None  # the Prefer header of the last Graph delta call
        self.last_query: dict[str, str] = {}

    # --- helpers for tests -------------------------------------------------

    def next_rev(self) -> int:
        self.rev = next(self._rev)
        return self.rev

    def put_google_event(self, calendar_id: str, event: dict[str, Any]) -> None:
        event = {**event, "_rev": self.next_rev()}
        events = self.google_events[calendar_id]
        events[:] = [e for e in events if e["id"] != event["id"]] + [event]

    def cancel_google_event(self, calendar_id: str, event_id: str, **extra: Any) -> None:
        self.put_google_event(calendar_id, {"id": event_id, "status": "cancelled", **extra})

    def put_ms_event(self, calendar_id: str, event: dict[str, Any]) -> None:
        event = {**event, "_rev": self.next_rev()}
        events = self.ms_events[calendar_id]
        events[:] = [e for e in events if e["id"] != event["id"]] + [event]

    def remove_ms_event(self, calendar_id: str, event_id: str) -> None:
        self.put_ms_event(calendar_id, {"id": event_id, "@removed": {"reason": "deleted"}})

    def set_ics(self, name: str, body: str | bytes, **options: Any) -> None:
        raw = body.encode() if isinstance(body, str) else body
        current = self.ics.get(name, {})
        self.ics[name] = {
            "body": raw,
            "etag": options.get("etag", f'"{hashlib.sha1(raw).hexdigest()[:12]}"'),
            "status": options.get("status", 200),
            "content_type": options.get("content_type", "text/calendar; charset=utf-8"),
            "location": options.get("location"),
            "hits": current.get("hits", 0),
            "conditional_hits": current.get("conditional_hits", 0),
        }

    def expire_access_tokens(self) -> None:
        self.access_tokens = dict.fromkeys(self.access_tokens, 0.0)

    # --- tokens ------------------------------------------------------------

    def issue(self, scope: str, *, provider: str, refresh: str | None) -> dict[str, Any]:
        access = f"fake-access-{secrets.token_hex(6)}"
        self.access_tokens[access] = time.time() + self.expires_in
        body: dict[str, Any] = {
            "access_token": access,
            "expires_in": self.expires_in,
            "scope": self.granted_scope or scope,
            "token_type": "Bearer",
        }
        if refresh is None and self.issue_refresh_token:
            refresh = f"fake-refresh-{secrets.token_hex(6)}"
        if refresh:
            self.refresh_tokens[refresh] = provider
            body["refresh_token"] = refresh
        return body

    def authorised(self, request: Request) -> bool:
        header = request.headers.get("authorization", "")
        token = header.removeprefix("Bearer ").strip()
        return self.access_tokens.get(token, 0.0) > time.time()

    def failure(self) -> Response | None:
        if self.failures:
            status = self.failures.pop(0)
            headers = {"Retry-After": self.retry_after} if self.retry_after else {}
            return JSONResponse(
                {"error": {"code": "fake_failure", "message": "x"}}, status, headers
            )
        return None


PROVIDER = FakeProvider()


def _pkce_ok(challenge: str, verifier: str) -> bool:
    digest = hashlib.sha256(verifier.encode()).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode() == challenge


# --- OAuth -----------------------------------------------------------------


async def authorize(request: Request) -> Response:
    provider = "google" if "/google/" in request.url.path else "microsoft"
    q = dict(request.query_params)
    PROVIDER.auth_requests.append({"provider": provider, **q})
    if q.get("client_id") != CLIENT_ID:
        return PlainTextResponse("unknown client", 400)
    if q.get("code_challenge_method") != "S256" or not q.get("code_challenge"):
        return PlainTextResponse("PKCE required", 400)
    redirect = q.get("redirect_uri", "")
    state = q.get("state", "")
    if PROVIDER.deny_authorize:
        return RedirectResponse(
            f"{redirect}?{urlencode({'error': 'access_denied', 'state': state})}", 302
        )
    code = f"fake-code-{secrets.token_hex(8)}"
    PROVIDER.codes[code] = {
        "challenge": q["code_challenge"],
        "redirect_uri": redirect,
        "provider": provider,
        "scope": q.get("scope", ""),
    }
    return RedirectResponse(f"{redirect}?{urlencode({'code': code, 'state': state})}", 302)


async def token(request: Request) -> Response:
    provider = "google" if "/google/" in request.url.path else "microsoft"
    form = {k: str(v) for k, v in (await request.form()).items()}
    PROVIDER.token_requests.append(
        {"provider": provider, **{k: v for k, v in form.items() if k != "client_secret"}}
    )
    if form.get("client_id") != CLIENT_ID or form.get("client_secret") != CLIENT_SECRET:
        return JSONResponse({"error": "invalid_client"}, 401)
    grant = form.get("grant_type")
    if grant == "authorization_code":
        info = PROVIDER.codes.pop(form.get("code", ""), None)  # single use
        if info is None or info["provider"] != provider:
            return JSONResponse({"error": "invalid_grant"}, 400)
        if info["redirect_uri"] != form.get("redirect_uri"):
            return JSONResponse(
                {"error": "invalid_grant", "error_description": "redirect_uri_mismatch"}, 400
            )
        if not _pkce_ok(info["challenge"], form.get("code_verifier", "")):
            return JSONResponse(
                {"error": "invalid_grant", "error_description": "bad verifier"}, 400
            )
        scope = GOOGLE_SCOPE if provider == "google" else MS_SCOPE
        return JSONResponse(PROVIDER.issue(scope, provider=provider, refresh=None))
    if grant == "refresh_token":
        old = form.get("refresh_token", "")
        if PROVIDER.fail_refresh or PROVIDER.refresh_tokens.get(old) != provider:
            return JSONResponse({"error": "invalid_grant"}, 400)
        scope = GOOGLE_SCOPE if provider == "google" else MS_SCOPE
        if provider == "microsoft":  # Microsoft rotates the refresh token
            del PROVIDER.refresh_tokens[old]
            return JSONResponse(
                PROVIDER.issue(
                    scope, provider=provider, refresh=f"fake-refresh-{secrets.token_hex(6)}"
                )
            )
        body = PROVIDER.issue(scope, provider=provider, refresh=old)
        body.pop("refresh_token", None)  # Google does not re-issue it
        return JSONResponse(body)
    return JSONResponse({"error": "unsupported_grant_type"}, 400)


async def revoke(request: Request) -> Response:
    form = await request.form()
    value = str(form.get("token", ""))
    PROVIDER.revoked.append(value)
    PROVIDER.refresh_tokens.pop(value, None)
    return Response(status_code=200)


# --- Google API ------------------------------------------------------------


def _unauth() -> Response:
    return JSONResponse({"error": {"code": 401, "message": "Invalid Credentials"}}, 401)


async def google_calendar_list(request: Request) -> Response:
    PROVIDER.requests.append(("GET", request.url.path))
    if (failed := PROVIDER.failure()) is not None:
        return failed
    if not PROVIDER.authorised(request):
        return _unauth()
    return JSONResponse({"kind": "calendar#calendarList", "items": PROVIDER.google_calendars})


async def google_events(request: Request) -> Response:
    PROVIDER.requests.append(("GET", request.url.path))
    if (failed := PROVIDER.failure()) is not None:
        return failed
    if not PROVIDER.authorised(request):
        return _unauth()
    calendar_id = request.path_params["calendar_id"]
    if calendar_id not in PROVIDER.google_events:
        return JSONResponse({"error": {"code": 404}}, 404)
    q = request.query_params
    sync_token = q.get("syncToken")
    if sync_token and PROVIDER.invalidate_sync_tokens:
        return JSONResponse(
            {"error": {"code": 410, "message": "Sync token is no longer valid"}}, 410
        )
    since = int(sync_token.removeprefix("st-")) if sync_token else 0
    items = [e for e in PROVIDER.google_events[calendar_id] if e["_rev"] > since]
    if not sync_token:  # a full listing returns live events plus cancelled exceptions of series
        items = [e for e in items if e.get("status") != "cancelled" or e.get("recurringEventId")]
    items = [{k: v for k, v in e.items() if k != "_rev"} for e in items]
    size = int(q.get("maxResults", "250"))
    if PROVIDER.page_size_cap:
        size = min(size, PROVIDER.page_size_cap)
    offset = int(q.get("pageToken", "pg-0").removeprefix("pg-"))
    page = items[offset : offset + size]
    body: dict[str, Any] = {"kind": "calendar#events", "timeZone": "Europe/Berlin", "items": page}
    if offset + size < len(items):
        body["nextPageToken"] = f"pg-{offset + size}"
    else:
        body["nextSyncToken"] = f"st-{PROVIDER.rev}"
    return JSONResponse(body)


# --- Microsoft Graph -------------------------------------------------------


async def ms_calendars(request: Request) -> Response:
    PROVIDER.requests.append(("GET", request.url.path))
    if (failed := PROVIDER.failure()) is not None:
        return failed
    if not PROVIDER.authorised(request):
        return _unauth()
    return JSONResponse({"value": PROVIDER.ms_calendars})


async def ms_delta(request: Request) -> Response:
    PROVIDER.requests.append(("GET", request.url.path))
    if (failed := PROVIDER.failure()) is not None:
        return failed
    if not PROVIDER.authorised(request):
        return _unauth()
    PROVIDER.last_prefer = request.headers.get("prefer")
    PROVIDER.last_query = dict(request.query_params)
    calendar_id = request.path_params["calendar_id"]
    if calendar_id not in PROVIDER.ms_events:
        return JSONResponse({"error": {"code": "ErrorItemNotFound"}}, 404)
    q = request.query_params
    token_value = q.get("$deltatoken")
    if token_value and PROVIDER.invalidate_sync_tokens:
        return JSONResponse({"error": {"code": "syncStateNotFound", "message": "gone"}}, 410)
    since = int(token_value.removeprefix("d-")) if token_value else 0
    items = [e for e in PROVIDER.ms_events[calendar_id] if e["_rev"] > since]
    if not token_value:
        items = [e for e in items if "@removed" not in e]
    items = [{k: v for k, v in e.items() if k != "_rev"} for e in items]
    offset = int(q.get("$skiptoken", "0"))
    size = PROVIDER.page_size_cap or 100
    page = items[offset : offset + size]
    base = f"{request.url.scheme}://{request.url.netloc}{request.url.path}"
    body: dict[str, Any] = {"value": page}
    if offset + size < len(items):
        extra = {k: v for k, v in q.items() if k not in {"$skiptoken"}}
        body["@odata.nextLink"] = f"{base}?{urlencode({**extra, '$skiptoken': offset + size})}"
    else:
        body["@odata.deltaLink"] = f"{base}?{urlencode({'$deltatoken': f'd-{PROVIDER.rev}'})}"
    return JSONResponse(body)


# --- ICS host --------------------------------------------------------------


async def ics_feed(request: Request) -> Response:
    name = request.path_params["name"]
    feed = PROVIDER.ics.get(name)
    if feed is None:
        return PlainTextResponse("not found", 404)
    feed["hits"] += 1
    if feed["status"] != 200:
        return PlainTextResponse("x", feed["status"])
    if feed["location"]:
        return Response(status_code=302, headers={"Location": feed["location"]})
    if request.headers.get("if-none-match") == feed["etag"]:
        feed["conditional_hits"] += 1
        return Response(status_code=304, headers={"ETag": feed["etag"]})
    return Response(
        feed["body"], 200, headers={"Content-Type": feed["content_type"], "ETag": feed["etag"]}
    )


# --- control ---------------------------------------------------------------


async def control(request: Request) -> Response:
    """``POST /_control``: ``{"op": "reset" | "ics" | "google_event" | "ms_event" | "set", ...}``."""
    data = await request.json()
    op = data.get("op")
    if op == "reset":
        PROVIDER.reset()
    elif op == "ics":
        PROVIDER.set_ics(data["name"], data["body"], **data.get("options", {}))
    elif op == "google_event":
        PROVIDER.put_google_event(data["calendar_id"], data["event"])
    elif op == "ms_event":
        PROVIDER.put_ms_event(data["calendar_id"], data["event"])
    elif op == "set":
        for key, value in data["values"].items():
            setattr(PROVIDER, key, value)
    elif op == "expire_tokens":
        PROVIDER.expire_access_tokens()
    else:
        return JSONResponse({"error": "unknown op"}, 400)
    return JSONResponse({"ok": True})


async def state(_request: Request) -> Response:
    return JSONResponse(
        {
            "requests": len(PROVIDER.requests),
            "revoked": len(PROVIDER.revoked),
            "tokens": len(PROVIDER.refresh_tokens),
            "now": datetime.now(UTC).isoformat(),
        }
    )


async def index(_request: Request) -> Response:
    return HTMLResponse("<p>Atlas fake calendar provider (tests only)</p>")


def build_app() -> Starlette:
    return Starlette(
        routes=[
            Route("/", index),
            Route("/google/auth", authorize),
            Route("/google/token", token, methods=["POST"]),
            Route("/google/revoke", revoke, methods=["POST"]),
            Route("/google/calendar/v3/users/me/calendarList", google_calendar_list),
            Route("/google/calendar/v3/calendars/{calendar_id:path}/events", google_events),
            Route("/microsoft/authorize", authorize),
            Route("/microsoft/token", token, methods=["POST"]),
            Route("/microsoft/v1.0/me/calendars", ms_calendars),
            Route("/microsoft/v1.0/me/calendars/{calendar_id:path}/calendarView/delta", ms_delta),
            Route("/ics/{name}", ics_feed),
            Route("/_control", control, methods=["POST"]),
            Route("/_state", state),
        ]
    )


app = build_app()


def main() -> None:  # pragma: no cover - exercised by the Playwright real-stack run
    import uvicorn

    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=9911)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument(
        "--seed", help="JSON file of seed instructions (a list of /_control bodies)"
    )
    args = parser.parse_args()
    if args.seed:
        with open(args.seed, encoding="utf-8") as handle:
            for item in json.load(handle):
                op = item["op"]
                if op == "ics":
                    PROVIDER.set_ics(item["name"], item["body"], **item.get("options", {}))
                elif op == "google_event":
                    PROVIDER.put_google_event(item["calendar_id"], item["event"])
                elif op == "ms_event":
                    PROVIDER.put_ms_event(item["calendar_id"], item["event"])
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
