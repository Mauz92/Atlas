from atlas.auth.ratelimit import RateLimiter


def test_allows_up_to_limit_then_blocks() -> None:
    limiter = RateLimiter(limit=3, per_seconds=60)
    assert limiter.allow("k", now=0) is True
    assert limiter.allow("k", now=1) is True
    assert limiter.allow("k", now=2) is True
    assert limiter.allow("k", now=3) is False


def test_window_slides() -> None:
    limiter = RateLimiter(limit=1, per_seconds=10)
    assert limiter.allow("k", now=0) is True
    assert limiter.allow("k", now=5) is False
    assert limiter.allow("k", now=11) is True


def test_keys_are_independent() -> None:
    limiter = RateLimiter(limit=1, per_seconds=60)
    assert limiter.allow("a", now=0) is True
    assert limiter.allow("b", now=0) is True
    assert limiter.allow("a", now=0) is False


def test_reset_clears_state() -> None:
    limiter = RateLimiter(limit=1, per_seconds=60)
    assert limiter.allow("k", now=0) is True
    limiter.reset()
    assert limiter.allow("k", now=0) is True


def test_retry_after_is_the_wait_for_the_oldest_hit() -> None:
    limiter = RateLimiter(limit=2, per_seconds=60)
    assert limiter.retry_after("k", now=0) == 1  # nothing recorded: the minimum
    limiter.allow("k", now=10)
    limiter.allow("k", now=20)
    assert limiter.allow("k", now=30) is False
    assert limiter.retry_after("k", now=30) == 40  # the hit at t=10 leaves the window at t=70
    assert limiter.retry_after("k", now=69.5) == 1
