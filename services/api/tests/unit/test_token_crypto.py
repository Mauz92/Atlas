"""Credential encryption (M5-01) — pure unit tests, no database.

Covers the properties the store depends on: an authenticated round-trip, fail-closed behaviour on
tampering / unknown keys / mismatched associated data, that the key never appears inside the
ciphertext, and the versioned-key handling that makes rotation feasible.
"""

from __future__ import annotations

import pytest

from atlas.calendar.crypto import DecryptionError, TokenCipher

PLAINTEXT = b'{"access_token":"ya29.SECRET","refresh_token":"1//REFRESH"}'
KEY_MATERIAL = "correct horse battery staple correct horse battery"
AAD = b"provider-credentials:user:google"


def _cipher(**keys: str) -> TokenCipher:
    keys.setdefault("v1", KEY_MATERIAL)
    return TokenCipher(keys, active_key_id="v1")


def test_round_trip_returns_the_original_plaintext() -> None:
    cipher = _cipher()
    blob = cipher.encrypt(PLAINTEXT, aad=AAD)
    assert cipher.decrypt(blob, key_id="v1", aad=AAD) == PLAINTEXT


def test_ciphertext_does_not_contain_the_plaintext_or_the_key() -> None:
    cipher = _cipher()
    blob = cipher.encrypt(PLAINTEXT, aad=AAD)
    assert blob != PLAINTEXT
    assert b"ya29.SECRET" not in blob
    assert b"1//REFRESH" not in blob
    # The configured key material must never be recoverable from the ciphertext.
    assert KEY_MATERIAL.encode() not in blob


def test_each_encryption_uses_a_fresh_nonce() -> None:
    cipher = _cipher()
    assert cipher.encrypt(PLAINTEXT, aad=AAD) != cipher.encrypt(PLAINTEXT, aad=AAD)


def test_tampering_is_detected_and_fails_closed() -> None:
    cipher = _cipher()
    blob = bytearray(cipher.encrypt(PLAINTEXT, aad=AAD))
    blob[-1] ^= 0x01  # flip one bit of the authentication tag
    with pytest.raises(DecryptionError):
        cipher.decrypt(bytes(blob), key_id="v1", aad=AAD)


def test_a_different_key_cannot_decrypt() -> None:
    blob = TokenCipher({"v1": KEY_MATERIAL}, active_key_id="v1").encrypt(PLAINTEXT, aad=AAD)
    other = TokenCipher({"v1": "a completely different secret value!!"}, active_key_id="v1")
    with pytest.raises(DecryptionError):
        other.decrypt(blob, key_id="v1", aad=AAD)


def test_an_unknown_key_id_fails_closed() -> None:
    cipher = _cipher()
    blob = cipher.encrypt(PLAINTEXT, aad=AAD)
    with pytest.raises(DecryptionError):
        cipher.decrypt(blob, key_id="v9", aad=AAD)


def test_mismatched_associated_data_fails_closed() -> None:
    cipher = _cipher()
    blob = cipher.encrypt(PLAINTEXT, aad=b"provider-credentials:user:google")
    with pytest.raises(DecryptionError):
        cipher.decrypt(blob, key_id="v1", aad=b"provider-credentials:other:google")


def test_a_truncated_blob_fails_closed() -> None:
    cipher = _cipher()
    with pytest.raises(DecryptionError):
        cipher.decrypt(b"short", key_id="v1", aad=AAD)


def test_previous_keys_still_decrypt_their_rows_during_rotation() -> None:
    """A rotating key set keeps old rows readable while new rows use the active key."""
    rotated = TokenCipher({"v1": "old material", "v2": "new material"}, active_key_id="v2")
    old_row = TokenCipher({"v1": "old material"}, active_key_id="v1").encrypt(PLAINTEXT, aad=AAD)
    assert rotated.decrypt(old_row, key_id="v1", aad=AAD) == PLAINTEXT
    assert rotated.active_key_id == "v2"
    # New writes are sealed with the active key, so they cannot be opened as the old one.
    new_row = rotated.encrypt(PLAINTEXT, aad=AAD)
    with pytest.raises(DecryptionError):
        TokenCipher({"v1": "old material"}, active_key_id="v1").decrypt(
            new_row, key_id="v2", aad=AAD
        )


def test_active_key_must_be_configured() -> None:
    with pytest.raises(ValueError):
        TokenCipher({"v1": KEY_MATERIAL}, active_key_id="v2")


def test_empty_key_material_is_rejected() -> None:
    with pytest.raises(ValueError):
        TokenCipher({"v1": ""}, active_key_id="v1")


def test_get_token_cipher_is_derived_from_settings() -> None:
    from atlas.calendar.crypto import get_token_cipher

    cipher = get_token_cipher()
    assert cipher.active_key_id == "v1"  # conftest sets TOKEN_ENCRYPTION_KEY only
    blob = cipher.encrypt(PLAINTEXT, aad=AAD)
    assert cipher.decrypt(blob, key_id="v1", aad=AAD) == PLAINTEXT
