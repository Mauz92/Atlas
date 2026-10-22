from atlas.auth.passwords import hash_password, needs_rehash, verify_password


def test_hash_is_salted_and_verifies() -> None:
    first = hash_password("correct horse battery staple")
    second = hash_password("correct horse battery staple")
    assert first != second
    assert verify_password(first, "correct horse battery staple")
    assert verify_password(second, "correct horse battery staple")


def test_wrong_password_rejected() -> None:
    hashed = hash_password("s3cret-password")
    assert not verify_password(hashed, "not-the-password")


def test_invalid_hash_is_not_verified() -> None:
    assert not verify_password("not-a-valid-hash", "whatever")


def test_fresh_hash_does_not_need_rehash() -> None:
    assert needs_rehash(hash_password("another-password")) is False


def test_garbage_hash_needs_rehash() -> None:
    assert needs_rehash("garbage") is True
