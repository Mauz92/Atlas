"""The ntfy adapter: a plain HTTPS ``POST`` of the constant hint (M8-04e; SYNC_PROTOCOL.md 14.8).

ntfy as a UnifiedPush server accepts a ``POST`` to the topic URL and hands the body to the
subscribed distributor app. Only the fixed payload is sent, with ``Cache: no`` (no server-side
cache of the message) and ``Firebase: no`` (ntfy.sh must not forward it to FCM); no title, tags or
priority. Redirects are not followed, the whole exchange is bounded by a timeout, the response body
is never read or logged, and the optional publish token travels only to the pinned origin.
"""

from __future__ import annotations

import logging

import httpx

from .base import HINT_PAYLOAD, HintOutcome, HintResult
from .origin import GatewayOrigin, InvalidHintEndpointError, validate_endpoint

logger = logging.getLogger("atlas.hints")


class NtfyGateway:
    def __init__(
        self,
        origin: GatewayOrigin,
        *,
        token: str = "",
        timeout: float = 5.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._origin = origin
        self._token = token
        self._timeout = timeout
        self._transport = transport

    async def send(self, endpoint: str) -> HintResult:
        try:
            url = validate_endpoint(endpoint, self._origin)  # defence in depth: re-check at send
        except InvalidHintEndpointError:
            return HintResult(HintOutcome.FAILED, "invalid_endpoint")
        headers = {"Cache": "no", "Firebase": "no", "Content-Type": "application/json"}
        if self._token:
            headers["Authorization"] = f"Bearer {self._token}"
        try:
            async with httpx.AsyncClient(
                timeout=self._timeout, follow_redirects=False, transport=self._transport
            ) as client:
                response = await client.post(url, content=HINT_PAYLOAD, headers=headers)
        except httpx.TimeoutException:
            return HintResult(HintOutcome.RETRY, "timeout")
        except httpx.HTTPError:
            return HintResult(HintOutcome.RETRY, "unreachable")
        return _classify(response.status_code, response.headers.get("retry-after"))


def _classify(status: int, retry_after: str | None) -> HintResult:
    if 200 <= status < 300:
        return HintResult(HintOutcome.DELIVERED)
    if status in {404, 410, 507}:  # the topic is unknown or its subscriber expired
        return HintResult(HintOutcome.INVALID, "gone")
    if status == 429:
        seconds = float(retry_after) if retry_after and retry_after.isdigit() else None
        return HintResult(HintOutcome.RETRY, "rate_limited", seconds)
    if 300 <= status < 400:
        return HintResult(HintOutcome.FAILED, "redirect")  # never followed
    if status in {401, 403}:
        return HintResult(HintOutcome.FAILED, "rejected")
    if status >= 500:
        return HintResult(HintOutcome.RETRY, "gateway_error")
    return HintResult(HintOutcome.FAILED, "rejected")
