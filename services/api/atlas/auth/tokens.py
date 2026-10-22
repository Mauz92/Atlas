"""Opaque session tokens.

The raw token is only ever held by the client cookie; the database stores its SHA-256
hash, so a database leak does not expose usable session tokens.
"""

from __future__ import annotations

import hashlib
import secrets

_TOKEN_BYTES = 32


def generate_session_token() -> str:
    return secrets.token_urlsafe(_TOKEN_BYTES)


def hash_session_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()
