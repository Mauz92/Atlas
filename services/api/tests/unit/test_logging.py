import logging

from atlas.logging import JsonFormatter

_SECRET = "SECRET-VALUE-DO-NOT-LOG"


def _record(**extra: object) -> logging.LogRecord:
    record = logging.LogRecord("atlas.test", logging.INFO, __file__, 1, "a message", None, None)
    for key, value in extra.items():
        setattr(record, key, value)
    return record


def test_sensitive_keys_are_redacted() -> None:
    output = JsonFormatter().format(
        _record(password=_SECRET, token=_SECRET, refresh_token=_SECRET, authorization=_SECRET)
    )
    assert _SECRET not in output
    assert "[redacted]" in output


def test_non_sensitive_fields_are_kept() -> None:
    output = JsonFormatter().format(_record(request_id="abc123", path="/health", status=200))
    assert "abc123" in output
    assert "/health" in output


def test_nested_structures_are_redacted() -> None:
    output = JsonFormatter().format(_record(context={"refresh_token": _SECRET, "note": "visible"}))
    assert _SECRET not in output
    assert "visible" in output


def test_message_and_level_are_preserved() -> None:
    output = JsonFormatter().format(_record())
    assert "a message" in output
    assert "INFO" in output
