"""The real API behind the simulation's :class:`ServerPort` interface (SYNC-02).

Requests are executed through the ASGI test client against the real FastAPI application and
PostgreSQL (the same fixtures the integration tests use), so the simulation and the conformance
traces exercise the shipped code, not a model of it.
"""

from __future__ import annotations

from typing import Any

from httpx import AsyncClient, Response

from .engine import Req, Resp


def _body(response: Response) -> Any:
    if not response.content:
        return None
    try:
        return response.json()
    except ValueError:
        return response.text


class RealServer:
    """The real application. ``client`` is the signed-in browser (cookie session). With
    ``add_device`` every simulated client may sign in as a device of its own (SYNC-06): requests
    carrying ``X-Sim-Client`` then travel with that client's bearer token and no cookies."""

    def __init__(self, client: AsyncClient, app: Any = None) -> None:
        self.client = client
        self.app = app
        #: client id -> (cookie-less client with the bearer header, device id)
        self.devices: dict[str, tuple[AsyncClient, str]] = {}
        self.revoked: set[str] = set()
        #: requests of a revoked device that were answered 2xx (must stay empty)
        self.served_after_revoke: list[str] = []

    async def add_device(self, cid: str, *, email: str, password: str) -> str:
        """Sign ``cid`` in as a device through the public endpoint; returns the device id."""
        from httpx import ASGITransport

        device_client = AsyncClient(transport=ASGITransport(app=self.app), base_url="http://test")
        r = await device_client.post(
            "/api/devices",
            json={"email": email, "password": password, "name": f"sim {cid}", "platform": "other"},
        )
        assert r.status_code == 201, r.text
        body = r.json()
        device_client.headers["Authorization"] = f"Bearer {body['token']}"
        self.devices[cid] = (device_client, body["device"]["id"])
        return str(body["device"]["id"])

    async def revoke_device(self, cid: str) -> None:
        """The owner signs the client's device out in Settings (the browser session, with CSRF)."""
        _client, device_id = self.devices[cid]
        resp = await self.handle(Req("DELETE", f"/api/devices/{device_id}"))
        assert resp.status == 204, resp
        self.revoked.add(cid)

    async def handle(self, req: Req) -> Resp:
        headers = dict(req.headers)
        cid = headers.pop("X-Sim-Client", None)
        if cid is not None and cid in self.devices:
            response = await self.devices[cid][0].request(
                req.method, req.path, params=req.params or None, json=req.body, headers=headers
            )
            if cid in self.revoked and response.status_code < 300:
                self.served_after_revoke.append(f"{cid} {req.method} {req.path}")
            return Resp(response.status_code, _body(response))
        if req.method not in ("GET", "HEAD"):
            token = self.client.cookies.get("atlas_csrf")
            if token:
                headers["X-CSRF-Token"] = token
        response = await self.client.request(
            req.method, req.path, params=req.params or None, json=req.body, headers=headers
        )
        return Resp(response.status_code, _body(response))

    async def head(self) -> int:
        """The feed head, asked from a cursor no server has reached (SYNC-01 ``cursor_ahead``)."""
        response = await self.handle(Req("GET", "/api/changes", params={"since": 2**62}))
        assert response.status == 200 and response.body["resync_reason"] == "cursor_ahead"
        return int(response.body["next_since"])

    async def all_entity_ids(self) -> list[str]:
        """Every task, project and note id the (single-user) test database holds, even deleted."""
        from sqlalchemy import text

        from atlas.db import session_scope

        async with session_scope() as session:
            rows = await session.execute(
                text(
                    "SELECT id::text FROM tasks UNION ALL SELECT id::text FROM projects"
                    " UNION ALL SELECT id::text FROM notes"
                )
            )
            return [row[0] for row in rows]
