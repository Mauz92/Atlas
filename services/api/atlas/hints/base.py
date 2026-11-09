"""The gateway interface (M8-04e; AGENTS.md 7.3): application code depends on this, not on ntfy."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Protocol

#: The only bytes that ever leave the server toward a push gateway (SYNC_PROTOCOL.md 14.8). No task,
#: note, title, count, cursor, user id, device name or time: arrival is the whole message.
SYNC_HINT_TASK = "sync.hint"

HINT_PAYLOAD = b'{"v":1,"k":"sync"}'


class HintOutcome(StrEnum):
    DELIVERED = "delivered"
    #: the gateway no longer knows the destination (404/410/507): disable it until re-registered
    INVALID = "invalid"
    #: worth another try (timeout, unreachable gateway, 429, 5xx)
    RETRY = "retry"
    #: not worth retrying (a refusal, a redirect, a malformed destination)
    FAILED = "failed"


@dataclass(frozen=True, slots=True)
class HintResult:
    outcome: HintOutcome
    #: a short machine class for diagnostics (``timeout``, ``unreachable``, ``gone``...), never text
    error_class: str | None = None
    retry_after: float | None = None


class HintGateway(Protocol):
    """Sends the constant hint to one registered destination. Must not raise for a network error."""

    async def send(self, endpoint: str) -> HintResult: ...
