"""The recovery code format, entry tolerance, hashing and the limiter it relies on (AUTH-01)."""

from __future__ import annotations

import math
import re

import pytest

from atlas.auth.ratelimit import RateLimiter
from atlas.auth.recovery import (
    ALPHABET,
    CODE_LENGTH,
    account_key,
    generate_code,
    hash_code,
    normalize_code,
)

DISPLAY = re.compile(r"^([0-9A-HJKMNP-TV-Z]{5}-){5}[0-9A-HJKMNP-TV-Z]{5}$")


def test_a_code_has_at_least_128_bits_in_grouped_crockford_base32() -> None:
    assert len(ALPHABET) == 32 and not set("ILOU") & set(ALPHABET)
    assert CODE_LENGTH * math.log2(len(ALPHABET)) >= 128
    for _ in range(50):
        assert DISPLAY.match(generate_code())


def test_codes_do_not_repeat_and_use_the_whole_alphabet() -> None:
    codes = [generate_code() for _ in range(400)]
    assert len(set(codes)) == len(codes)
    seen = {ch for code in codes for ch in code.replace("-", "")}
    assert seen == set(ALPHABET)  # 12000 draws: every symbol appears


def test_entry_tolerates_case_dashes_spaces_and_lookalikes() -> None:
    code = generate_code()
    plain = code.replace("-", "")
    assert normalize_code(code) == plain
    assert normalize_code(code.lower()) == plain
    assert normalize_code(f"  {code.replace('-', ' ')}\n") == plain
    assert normalize_code(plain) == plain
    assert normalize_code("-".join(code.split("-")).replace("-", "_")) == plain
    assert normalize_code("O" * 30) == "0" * 30
    assert normalize_code("I" * 15 + "l" * 15) == "1" * 30


@pytest.mark.parametrize(
    "bad",
    ["", "x", "A" * 29, "A" * 31, "U" * 30, "A" * 29 + "!", "é" * 30, "A" * 500, "0" * 29 + "٣"],
)
def test_anything_that_cannot_be_a_code_is_refused(bad: str) -> None:
    assert normalize_code(bad) is None


def test_the_hash_is_keyed_by_the_salt_and_never_the_code() -> None:
    code = "0" * 30
    first = hash_code(b"a" * 16, code)
    assert first == hash_code(b"a" * 16, code)
    assert first != hash_code(b"b" * 16, code)
    assert first != hash_code(b"a" * 16, "1" * 30)
    assert code not in first and len(first) == 64


def test_the_account_key_ignores_case_and_space_and_holds_no_address() -> None:
    assert account_key(" Owner@Example.com ") == account_key("owner@example.com")
    assert "owner" not in account_key("owner@example.com")


def test_a_throttle_is_a_bounded_delay_that_blocked_attempts_cannot_extend() -> None:
    limiter = RateLimiter(limit=5, per_seconds=900)
    assert [limiter.allow("a", now=float(t)) for t in range(5)] == [True] * 5
    # An attacker keeps hammering for 14 minutes: refused, and not counted against the window
    assert not any(limiter.allow("a", now=60.0 * m) for m in range(1, 15))
    assert limiter.retry_after("a", now=840.0) == 60
    # The first hit ages out at t=900: the owner can try again, the lock was never permanent
    assert limiter.allow("a", now=900.5)
    assert limiter.allow("b", now=1.0)  # another account is untouched


def test_the_limiter_does_not_grow_without_bound() -> None:
    limiter = RateLimiter(limit=1, per_seconds=10)
    for i in range(5000):
        limiter.allow(f"k{i}", now=0.0)
    limiter.allow("fresh", now=100.0)  # everything above is stale by now
    assert len(limiter._hits) < 100
