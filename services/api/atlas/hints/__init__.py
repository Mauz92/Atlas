"""Content-free sync hints to a self-hosted UnifiedPush gateway (M8-04e, ADR-0068 D6).

The application depends on :class:`~atlas.hints.base.HintGateway`;
:class:`~atlas.hints.ntfy.NtfyGateway` is the one adapter.
See ``SYNC_PROTOCOL.md`` 14.8 and ``SECURITY.md`` 14.
"""

from .base import HINT_PAYLOAD, HintGateway, HintOutcome, HintResult
from .origin import (
    GatewayOrigin,
    InvalidGatewayConfigError,
    InvalidHintEndpointError,
    parse_gateway_origin,
    validate_endpoint,
)

__all__ = [
    "HINT_PAYLOAD",
    "GatewayOrigin",
    "HintGateway",
    "HintOutcome",
    "HintResult",
    "InvalidGatewayConfigError",
    "InvalidHintEndpointError",
    "parse_gateway_origin",
    "validate_endpoint",
]
