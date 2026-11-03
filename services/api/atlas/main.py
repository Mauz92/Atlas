"""FastAPI application factory."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.middleware.trustedhost import TrustedHostMiddleware

from . import __version__
from .api import (
    auth_router,
    calendar_router,
    changes_router,
    export_router,
    folders_router,
    health_router,
    instance_router,
    notes_router,
    notifications_router,
    projects_router,
    resolutions_router,
    search_router,
    tasks_router,
)
from .api.sync_gate import sync_error_response, sync_gate
from .config import get_settings
from .db import dispose_engine
from .logging import configure_logging
from .middleware import CsrfMiddleware, RequestContextMiddleware, SecurityHeadersMiddleware
from .sync.protocol import SyncError

#: Requests under this prefix carry OAuth token material, so their validation errors must not echo
#: the submitted value (SECURITY.md T2); the auth endpoints carry passwords.
_CREDENTIAL_PATH_PREFIXES = ("/api/calendar/credentials", "/api/auth/")


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    configure_logging()
    get_settings().validate_for_runtime()
    try:
        yield
    finally:
        await dispose_engine()


def _is_unencodable(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        return True
    return False


_MAX_ECHOED_INPUT_CHARS = 1024


class _HostCheckExceptHealth(TrustedHostMiddleware):
    """Host allow-list for everything except ``/health*``.

    The Compose healthcheck calls ``http://localhost:8000/health`` and nginx proxies ``/health``
    with the upstream's own name, so a production ``ALLOWED_HOSTS=atlas.example.com`` used to make
    the api container permanently unhealthy (P0-1 smoke test). The health endpoints return no
    host-derived content, so exempting them costs nothing.
    """

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        if scope["type"] == "http" and str(scope.get("path", "")).startswith("/health"):
            await self.app(scope, receive, send)
            return
        await super().__call__(scope, receive, send)


def _is_oversized(value: object) -> bool:
    """A huge offending string (a 5 MiB note body) is not echoed back in a 422."""
    return isinstance(value, str) and len(value) > _MAX_ECHOED_INPUT_CHARS


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="Atlas API",
        version=__version__,
        openapi_url="/api/openapi.json",
        # Interactive docs are a convenience in development and needless surface in production.
        docs_url=None if settings.is_production else "/api/docs",
        redoc_url=None,
        lifespan=lifespan,
        dependencies=[Depends(sync_gate)],
    )

    # Added last runs first: request context is outermost, CSRF innermost.
    app.add_middleware(CsrfMiddleware)
    app.add_middleware(SecurityHeadersMiddleware)
    app.add_middleware(RequestContextMiddleware)

    if settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_origins,
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    if settings.allowed_hosts:
        app.add_middleware(_HostCheckExceptHealth, allowed_hosts=settings.allowed_hosts)

    app.include_router(health_router)
    app.include_router(auth_router)
    app.include_router(notes_router)
    app.include_router(folders_router)
    app.include_router(tasks_router)
    app.include_router(projects_router)
    app.include_router(search_router)
    app.include_router(calendar_router)
    app.include_router(changes_router)
    app.include_router(resolutions_router)
    app.include_router(notifications_router)
    app.include_router(export_router)
    app.include_router(instance_router)

    app.add_exception_handler(SyncError, sync_error_response)  # type: ignore[arg-type]

    @app.exception_handler(RequestValidationError)
    async def _redact_credential_validation_errors(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        """Return a 422 without echoing the offending input for credential endpoints.

        FastAPI's default body includes each error's ``input`` value. On the credential endpoints
        that value can be a token, so ``input`` is stripped there; every other endpoint keeps the
        framework default behaviour and response shape.
        """
        errors: list[dict[str, Any]] = [dict(error) for error in exc.errors()]
        if request.url.path.startswith(_CREDENTIAL_PATH_PREFIXES):
            errors = [
                {key: value for key, value in error.items() if key != "input"} for error in errors
            ]
        else:
            # A JSON string with a lone surrogate (``"\\ud800"``) is rejected by validation but
            # cannot be encoded back to UTF-8: echoing it would turn the 422 into a 500.
            errors = [
                {key: value for key, value in error.items() if key != "input"}
                if _is_unencodable(error.get("input")) or _is_oversized(error.get("input"))
                else error
                for error in errors
            ]
        return JSONResponse(
            status_code=422,
            content={"detail": jsonable_encoder(errors)},
        )

    return app


app = create_app()
