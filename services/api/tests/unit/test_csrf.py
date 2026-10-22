from atlas.auth.csrf import issue_csrf_token, validate_csrf_token


def test_valid_token_round_trips() -> None:
    token = issue_csrf_token("session-token")
    assert validate_csrf_token(token, "session-token", max_age=3600)


def test_token_bound_to_session() -> None:
    token = issue_csrf_token("session-token")
    assert not validate_csrf_token(token, "other-session", max_age=3600)


def test_tampered_token_rejected() -> None:
    token = issue_csrf_token("session-token")
    assert not validate_csrf_token(token + "x", "session-token", max_age=3600)


def test_expired_token_rejected() -> None:
    token = issue_csrf_token("session-token")
    assert not validate_csrf_token(token, "session-token", max_age=-1)
