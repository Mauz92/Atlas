from atlas.jobs.queue import backoff_delay


def test_backoff_grows_then_caps() -> None:
    early = [backoff_delay(1, base=5) for _ in range(200)]
    later = [backoff_delay(10, base=5) for _ in range(200)]
    assert max(early) < min(later)
    assert max(later) <= 900.0


def test_backoff_is_jittered() -> None:
    values = {backoff_delay(4, base=5) for _ in range(50)}
    assert len(values) > 1


def test_backoff_is_positive() -> None:
    assert all(backoff_delay(n, base=5) > 0 for n in range(1, 12))
