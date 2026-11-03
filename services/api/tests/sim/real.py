"""The real API behind the simulation's :class:`ServerPort` interface (SYNC-02).

Requests are executed through the ASGI test client against the real FastAPI application and
PostgreSQL (the same fixtures the integration tests use), so the simulation and the conformance
traces exercise the shipped code, not a model of it.
"""

from __future__ import annotations

from httpx import AsyncClient

from .engine import Req, Resp


class RealServer:
    def __init__(self, client: AsyncClient) -> None:
        self.client = client

    async def handle(self, req: Req) -> Resp:
        headers = dict(req.headers)
        if req.method not in ("GET", "HEAD"):
            token = self.client.cookies.get("atlas_csrf")
            if token:
                headers["X-CSRF-Token"] = token
        response = await self.client.request(
            req.method, req.path, params=req.params or None, json=req.body, headers=headers
        )
        body = None
        if response.content:
            try:
                body = response.json()
            except ValueError:
                body = response.text
        return Resp(response.status_code, body)

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
