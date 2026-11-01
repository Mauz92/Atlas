import pytest

from atlas.config import Settings

_PLACEHOLDER = "dev-insecure-change-me"


def test_production_rejects_placeholder_secrets() -> None:
    settings = Settings(
        atlas_env="production",
        secret_key=_PLACEHOLDER,
        session_secret="real-session-secret",
        token_encryption_key="real-token-key",
    )
    with pytest.raises(RuntimeError):
        settings.validate_for_runtime()


def test_production_accepts_real_secrets() -> None:
    settings = Settings(
        atlas_env="production",
        secret_key="a-real-secret",
        session_secret="another-real-secret",
        token_encryption_key="yet-another-real-secret",
    )
    settings.validate_for_runtime()


def test_development_allows_default_secrets() -> None:
    Settings(atlas_env="development").validate_for_runtime()


def test_secure_cookies_only_in_production() -> None:
    production = Settings(
        atlas_env="production",
        secret_key="a",
        session_secret="b",
        token_encryption_key="c",
    )
    assert production.secure_cookies is True
    assert production.is_production is True
    assert Settings(atlas_env="development").secure_cookies is False


def test_public_base_url_trailing_slash_is_stripped() -> None:
    assert Settings(public_base_url="https://atlas.example/").public_base_url == (
        "https://atlas.example"
    )


def test_allowed_hosts_is_parsed() -> None:
    assert Settings(allowed_hosts=["atlas.example", "localhost"]).allowed_hosts == [
        "atlas.example",
        "localhost",
    ]


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("", []),
        ("atlas.example.com", ["atlas.example.com"]),
        ("a.example, b.example", ["a.example", "b.example"]),
        ('["a.example"]', ["a.example"]),
    ],
)
def test_list_settings_accept_the_documented_comma_separated_form(
    monkeypatch: pytest.MonkeyPatch, raw: str, expected: list[str]
) -> None:
    """Regression: ``ALLOWED_HOSTS=`` / ``ALLOWED_HOSTS=host`` used to crash startup."""
    monkeypatch.setenv("ALLOWED_HOSTS", raw)
    monkeypatch.setenv("CORS_ORIGINS", raw)
    settings = Settings()
    assert settings.allowed_hosts == expected
    assert settings.cors_origins == expected
