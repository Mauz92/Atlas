"""CSRF protection using a signed, session-bound token (double-submit).

The token is delivered in a readable cookie and must be echoed in the ``X-CSRF-Token``
header on unsafe requests. It is signed with the session secret and bound to the current
session token, so a token from one session cannot be replayed in another.
"""

from __future__ import annotations

import hmac

from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from ..config import get_settings

_SALT = "atlas-csrf"


def _serializer() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(get_settings().session_secret, salt=_SALT)


def issue_csrf_token(session_token: str) -> str:
    return _serializer().dumps({"s": session_token})


def validate_csrf_token(token: str, session_token: str, max_age: int) -> bool:
    try:
        data = _serializer().loads(token, max_age=max_age)
    except (BadSignature, SignatureExpired):
        return False
    bound = data.get("s", "")
    return isinstance(bound, str) and hmac.compare_digest(bound, session_token)
