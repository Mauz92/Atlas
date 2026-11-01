"""FastAPI application factory."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request
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
    notes_router,
    notifications_router,
    projects_router,
    tasks_router,
)
from .config import get_settings
from .db import dispose_engine
from .logging import configure_logging
from .middleware import CsrfMiddleware, RequestContextMiddleware, SecurityHeadersMiddleware

#: Requests under this prefix carry OAuth token material, so their validation errors must not echo
#: the submitted value (SECURITY.md T2).
_CREDENTIAL_PATH_PREFIX = "/api/calendar/credentials"


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    configure_logging()
    get_settings().validate_for_runtime()
    try:
        yield
    finally:
        await dispose_engine()


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
        app.add_middleware(TrustedHostMiddleware, allowed_hosts=settings.allowed_hosts)

    app.include_router(health_router)
    app.include_router(auth_router)
    app.include_router(notes_router)
    app.include_router(folders_router)
    app.include_router(tasks_router)
    app.include_router(projects_router)
    app.include_router(calendar_router)
    app.include_router(changes_router)
    app.include_router(notifications_router)
    app.include_router(export_router)

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
        if request.url.path.startswith(_CREDENTIAL_PATH_PREFIX):
            errors = [
                {key: value for key, value in error.items() if key != "input"} for error in errors
            ]
        return JSONResponse(
            status_code=422,
            content={"detail": jsonable_encoder(errors)},
        )

    return app


app = create_app()
