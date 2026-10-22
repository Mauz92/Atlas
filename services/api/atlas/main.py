"""FastAPI application factory."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware

from . import __version__
from .api import auth_router, folders_router, health_router, notes_router, tasks_router
from .config import get_settings
from .db import dispose_engine
from .logging import configure_logging
from .middleware import CsrfMiddleware, RequestContextMiddleware, SecurityHeadersMiddleware


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
    return app


app = create_app()
