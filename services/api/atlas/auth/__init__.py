"""Authentication primitives: password hashing, session tokens, CSRF and rate limiting.

No custom cryptography: Argon2id and HMAC/SHA-256 are used through maintained libraries.
"""

from .csrf import issue_csrf_token, validate_csrf_token
from .passwords import hash_password, needs_rehash, verify_password
from .ratelimit import RateLimiter
from .tokens import generate_session_token, hash_session_token

__all__ = [
    "RateLimiter",
    "generate_session_token",
    "hash_password",
    "hash_session_token",
    "issue_csrf_token",
    "needs_rehash",
    "validate_csrf_token",
    "verify_password",
]
