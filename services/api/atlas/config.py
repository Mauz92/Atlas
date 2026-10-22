"""Application settings.

Configuration is environment-driven (see ``.env.example``). Secrets have development
defaults so that tests and local runs work without a filled ``.env``; production runs must
provide real values (validated in :meth:`Settings.validate_for_runtime`).
"""

from __future__ import annotations

from functools import lru_cache

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

_DEV_SECRET = "dev-insecure-change-me"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    atlas_env: str = "development"
    public_base_url: str = "http://localhost:8000"

    secret_key: str = _DEV_SECRET
    session_secret: str = _DEV_SECRET
    token_encryption_key: str = _DEV_SECRET

    database_url: str = "postgresql+psycopg://atlas:atlas@localhost:5432/atlas"
    notes_root: str = "./data/notes"
    # How often the worker reconciles the note index with the filesystem.
    notes_reconcile_seconds: int = 300

    session_cookie_name: str = "atlas_session"
    csrf_cookie_name: str = "atlas_csrf"
    session_ttl_seconds: int = 60 * 60 * 24 * 14
    auth_rate_limit_per_minute: int = 10

    cors_origins: list[str] = Field(default_factory=list)
    # When non-empty, only these Host header values are accepted (production hardening).
    allowed_hosts: list[str] = Field(default_factory=list)

    @field_validator("public_base_url")
    @classmethod
    def _strip_trailing_slash(cls, value: str) -> str:
        return value.rstrip("/")

    @property
    def is_production(self) -> bool:
        return self.atlas_env.lower() == "production"

    @property
    def secure_cookies(self) -> bool:
        return self.is_production

    def validate_for_runtime(self) -> None:
        """Reject placeholder secrets in production."""
        if not self.is_production:
            return
        placeholders = {_DEV_SECRET, "change-me", ""}
        for name in ("secret_key", "session_secret", "token_encryption_key"):
            if getattr(self, name) in placeholders:
                msg = f"{name} must be set to a real secret in production"
                raise RuntimeError(msg)


@lru_cache
def get_settings() -> Settings:
    return Settings()
