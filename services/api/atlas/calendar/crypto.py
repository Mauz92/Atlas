"""Authenticated encryption for stored OAuth credentials (M5-01).

Uses the maintained **``cryptography``** library's high-level AEAD API (``AESGCM``, AES-256-GCM) —
Atlas writes no cryptographic primitives of its own (AGENTS.md §7.5, ``DECISIONS.md`` ADR-0027).

Key handling:

- The secret lives **outside the database** in configuration (``Settings.token_encryption_key``) and
  is never persisted, returned by an API or logged.
- A 256-bit key is derived from that material with **HKDF-SHA256** (a maintained KDF), binding the
  derived key to its ``key_id``; the ``key_id`` is recorded alongside each ciphertext so a rotation
  can identify (and later re-encrypt) rows sealed with an older key.
- A **rotating key set** is supported: the cipher holds the active key plus any previous keys, so
  rows sealed before a rotation stay readable during the changeover.
- Each ciphertext is ``nonce || sealed`` where ``nonce`` is 96 random bits; the AEAD additionally
  authenticates optional associated data (the service binds it to the user+provider), so a
  ciphertext cannot be replayed onto another row. Tampering and unknown keys fail closed
  (:class:`DecryptionError`) rather than returning garbage.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from functools import lru_cache

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from ..config import get_settings

_NONCE_BYTES = 12
_KEY_BYTES = 32
#: Fixed, application-specific HKDF salt. The varying input is the ``key_id`` (HKDF ``info``).
_HKDF_SALT = b"atlas.provider-credentials.v1"


class DecryptionError(Exception):
    """A stored ciphertext could not be authenticated or decrypted.

    Raised for tampering, a wrong/unknown key, a truncated blob or a mismatched associated-data
    value. The message never contains key material or plaintext.
    """


def _derive_key(material: str, key_id: str) -> bytes:
    hkdf = HKDF(
        algorithm=hashes.SHA256(),
        length=_KEY_BYTES,
        salt=_HKDF_SALT,
        info=key_id.encode("utf-8"),
    )
    return hkdf.derive(material.encode("utf-8"))


class TokenCipher:
    """Encrypt/decrypt stored credential blobs with a set of versioned keys.

    ``keys`` maps a ``key_id`` to its secret material; ``active_key_id`` selects the key used for
    **encryption**. Decryption always uses the ``key_id`` recorded with the row, so a rotation can
    decrypt old rows while sealing new ones with the active key.
    """

    def __init__(self, keys: Mapping[str, str], *, active_key_id: str) -> None:
        if active_key_id not in keys:
            raise ValueError(f"active key id {active_key_id!r} is not among the configured keys")
        if any(not material for material in keys.values()):
            raise ValueError("key material must not be empty")
        self._keys: dict[str, AESGCM] = {
            key_id: AESGCM(_derive_key(material, key_id)) for key_id, material in keys.items()
        }
        self._active_key_id = active_key_id

    @property
    def active_key_id(self) -> str:
        return self._active_key_id

    def encrypt(self, plaintext: bytes, *, aad: bytes | None = None) -> bytes:
        """Seal ``plaintext`` with the active key; returns ``nonce || ciphertext+tag``."""
        nonce = os.urandom(_NONCE_BYTES)
        sealed = self._keys[self._active_key_id].encrypt(nonce, plaintext, aad)
        return nonce + sealed

    def decrypt(self, blob: bytes, *, key_id: str, aad: bytes | None = None) -> bytes:
        """Open a blob sealed by ``key_id``; raises :class:`DecryptionError` on any failure."""
        aead = self._keys.get(key_id)
        if aead is None:
            raise DecryptionError("stored credential was sealed with an unknown key")
        if len(blob) <= _NONCE_BYTES:
            raise DecryptionError("stored credential is not a valid ciphertext")
        nonce, sealed = blob[:_NONCE_BYTES], blob[_NONCE_BYTES:]
        try:
            return aead.decrypt(nonce, sealed, aad)
        except InvalidTag as exc:
            raise DecryptionError("stored credential failed authentication") from exc


@lru_cache
def get_token_cipher() -> TokenCipher:
    """The process-wide cipher built from settings (active key plus any previous keys)."""
    settings = get_settings()
    keys: dict[str, str] = {settings.token_encryption_key_id: settings.token_encryption_key}
    for key_id, material in settings.token_encryption_previous_keys.items():
        keys.setdefault(key_id, material)
    return TokenCipher(keys, active_key_id=settings.token_encryption_key_id)
