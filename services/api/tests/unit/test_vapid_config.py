"""Pure Web Push VAPID configuration rules (M8-02).

The key pair is configuration: it is enabled only when all three values are present, and a partial
configuration is a single explicit "off" state (so nothing attempts a delivery it cannot sign). None
of these helpers ever emits a key value — only the settings names that are missing.
"""

from __future__ import annotations

from types import SimpleNamespace

from atlas.notifications.vapid import (
    VapidConfig,
    build_vapid_config,
    is_configured,
    missing_vapid_fields,
)

PUBLIC = "BPublicKeyPart"
PRIVATE = "PrivateKeyPart"
SUBJECT = "mailto:ops@atlas.test"


def settings(
    public: str | None = PUBLIC, private: str | None = PRIVATE, subject: str | None = SUBJECT
) -> SimpleNamespace:
    return SimpleNamespace(
        vapid_public_key=public or "",
        vapid_private_key=private or "",
        vapid_subject=subject or "",
    )


def test_a_complete_key_pair_enables_web_push() -> None:
    config = build_vapid_config(settings())
    assert config == VapidConfig(public_key=PUBLIC, private_key=PRIVATE, subject=SUBJECT)
    assert is_configured(settings())


def test_values_are_trimmed_before_use() -> None:
    config = build_vapid_config(
        settings(public=f"  {PUBLIC} ", private=f"\n{PRIVATE}\t", subject="")
    )
    assert config is None  # a blank subject still disables it
    config = build_vapid_config(
        settings(public=f"  {PUBLIC} ", private=f"\n{PRIVATE}\t", subject=" x ")
    )
    assert config is not None
    assert config.public_key == PUBLIC
    assert config.private_key == PRIVATE
    assert config.subject == "x"


def test_missing_any_single_value_disables_the_feature() -> None:
    assert build_vapid_config(settings(public="")) is None
    assert build_vapid_config(settings(private="")) is None
    assert build_vapid_config(settings(subject="")) is None
    assert build_vapid_config(settings("", "", "")) is None
    assert not is_configured(settings(private=""))


def test_missing_fields_lists_names_only_never_values() -> None:
    missing = missing_vapid_fields(settings(public="", subject=""))
    assert missing == ["vapid_public_key", "vapid_subject"]
    joined = " ".join(missing)
    assert PRIVATE not in joined  # a diagnostic never leaks the key material


def test_nothing_missing_reports_an_empty_list() -> None:
    assert missing_vapid_fields(settings()) == []
