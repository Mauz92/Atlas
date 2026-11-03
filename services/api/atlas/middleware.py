"""ASGI middleware: request IDs, structured access logs, security headers and CSRF."""

from __future__ import annotations

import logging
import time
import uuid
from collections.abc import Awaitable, Callable

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from .auth.csrf import validate_csrf_token
from .auth.devices import bearer_token
from .config import get_settings

logger = logging.getLogger("atlas.http")

_UNSAFE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
# ``/api/devices`` (POST) signs a device in with the account password, like login: it needs no
# session, so there is no ambient credential to forge a request with.
_CSRF_EXEMPT_PATHS = frozenset({"/api/auth/login", "/api/auth/setup", "/api/devices"})


class RequestContextMiddleware(BaseHTTPMiddleware):
    """Attach a request id and emit one structured access log per request."""

    async def dispatch(
        self, request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        request_id = request.headers.get("x-request-id") or uuid.uuid4().hex
        request.state.request_id = request_id
        started = time.perf_counter()
        response = await call_next(request)
        duration_ms = round((time.perf_counter() - started) * 1000, 2)
        response.headers["X-Request-ID"] = request_id
        logger.info(
            "request",
            extra={
                "request_id": request_id,
                "method": request.method,
                "path": request.url.path,
                "status": response.status_code,
                "duration_ms": duration_ms,
            },
        )
        return response


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(
        self, request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        response.headers.setdefault(
            "Content-Security-Policy",
            "default-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
        )
        if request.url.path.startswith("/api"):
            response.headers.setdefault("Cache-Control", "no-store")
        if get_settings().is_production:
            response.headers.setdefault(
                "Strict-Transport-Security", "max-age=31536000; includeSubDomains"
            )
        return response


class CsrfMiddleware(BaseHTTPMiddleware):
    """Double-submit CSRF check for authenticated unsafe requests."""

    async def dispatch(
        self, request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        # A request carrying a bearer token is authenticated by that token alone and its cookies
        # are ignored by the auth dependencies (``deps.bearer_token``), so there is no ambient
        # credential for a cross-site request to ride on. Anything else is checked as before.
        if (
            request.method in _UNSAFE_METHODS
            and request.url.path not in _CSRF_EXEMPT_PATHS
            and bearer_token(request) is None
        ):
            settings = get_settings()
            session_token = request.cookies.get(settings.session_cookie_name)
            if session_token:  # only enforce when a session exists
                header = request.headers.get("x-csrf-token", "")
                cookie = request.cookies.get(settings.csrf_cookie_name, "")
                if not header or not cookie or header != cookie:
                    return JSONResponse({"detail": "CSRF validation failed"}, status_code=403)
                if not validate_csrf_token(header, session_token, settings.session_ttl_seconds):
                    return JSONResponse({"detail": "CSRF validation failed"}, status_code=403)
        return await call_next(request)
