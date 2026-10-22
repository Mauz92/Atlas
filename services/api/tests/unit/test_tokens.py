from atlas.auth.tokens import generate_session_token, hash_session_token


def test_tokens_are_unique() -> None:
    assert len({generate_session_token() for _ in range(100)}) == 100


def test_hash_is_stable_and_hex() -> None:
    token = "a-sample-token"
    digest = hash_session_token(token)
    assert digest == hash_session_token(token)
    assert len(digest) == 64
    int(digest, 16)


def test_hash_hides_the_token() -> None:
    token = generate_session_token()
    assert token not in hash_session_token(token)
