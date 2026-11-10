"""Application settings.

Configuration is environment-driven (see ``.env.example``). Secrets have development
defaults so that tests and local runs work without a filled ``.env``; production runs must
provide real values (validated in :meth:`Settings.validate_for_runtime`).
"""

from __future__ import annotations

import json
from functools import lru_cache
from typing import Annotated

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

MIN_RETENTION_DAYS = 30  # mirrors atlas.changes.retention (config must not import the app)

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
    #: Identifier recorded with each encrypted credential so keys can be rotated (M5-01).
    token_encryption_key_id: str = "v1"
    #: Retired keys, keyed by their id, used only to decrypt rows a rotation has not re-sealed yet.
    token_encryption_previous_keys: dict[str, str] = Field(default_factory=dict)

    database_url: str = "postgresql+psycopg://atlas:atlas@localhost:5432/atlas"
    notes_root: str = "./data/notes"
    # How often the worker reconciles the note index with the filesystem.
    notes_reconcile_seconds: int = 300
    # Note history (SYNC-04, ADR-0059 D5): the base of a three-way merge. A note keeps its newest
    # ``note_history_keep_revisions`` revisions and every revision younger than
    # ``note_history_keep_days``, but never more than ``note_history_max_revisions`` revisions or
    # ``note_history_max_bytes`` of distinct content (the newest revisions are always kept). A
    # base that has been pruned is not merged on a guess: the write becomes a conflict copy.
    note_history_keep_revisions: int = 20
    note_history_keep_days: int = 90
    note_history_max_revisions: int = 200
    note_history_max_bytes: int = 64 * 1024 * 1024
    # How often (seconds) the worker scans every connected calendar and re-syncs it from its stored
    # cursor, recovering any change a lost/never-received provider notification did not deliver
    # (M5-10). Notifications are hints, never a complete change log (AGENTS.md §10).
    calendar_reconcile_seconds: int = 300
    # How long (seconds) a sync run's durable ``in_progress`` marker may stay set before it is
    # treated as stale — a run that crashed without clearing it. Within this window the marker is
    # reported as ``in_progress``; past it, the marker is ignored (so a crashed run cannot lie) and
    # the next scan re-runs the calendar.
    calendar_sync_stale_seconds: int = 900

    # --- Calendar providers (Stage A, read-only; M5-03/04/05/11, ADR-0071) -----------------------
    # Google OAuth *web application* client (Cloud Console). Empty = Google is "not configured" and
    # the UI shows setup help instead of a Connect button. The redirect URI is never configured: it
    # is always ``{PUBLIC_BASE_URL}/api/calendar/google/callback`` (see ``atlas.calendar.oauth``).
    google_client_id: str = ""
    google_client_secret: str = ""
    # Microsoft Entra app registration (delegated, Calendars.Read + offline_access). ``common``
    # accepts personal and work accounts, ``consumers`` personal only, or a single tenant id.
    microsoft_client_id: str = ""
    microsoft_client_secret: str = ""
    microsoft_tenant: str = "common"
    # How often (seconds, at least 300) a secret ICS feed (Proton and others) is polled. Providers
    # refresh their own feeds slowly (Proton: hours), so polling faster only wastes requests.
    ics_poll_seconds: int = Field(default=900, ge=300)
    # Largest ICS body accepted (bytes) and the per-request timeout (seconds).
    ics_max_bytes: int = Field(default=10 * 1024 * 1024, ge=1024)
    ics_timeout_seconds: float = Field(default=20.0, gt=0, le=120)
    # Development only: accept ``http://`` feeds, and feeds on a loopback/private address. Both are
    # refused by default and the private-host flag is refused outright in production (SECURITY T24).
    ics_allow_http: bool = False
    ics_allow_private_hosts: bool = False
    # How many days either side of today the Microsoft delta window covers (calendarView is a
    # windowed query); events outside the window are not synced.
    calendar_window_past_days: int = Field(default=90, ge=7, le=730)
    calendar_window_future_days: int = Field(default=365, ge=30, le=1095)
    # How long (seconds) an OAuth ``state`` stays valid. Single use, bound to the browser session.
    calendar_oauth_state_ttl_seconds: int = Field(default=600, ge=60, le=3600)
    # Test/dev only: route every provider endpoint (OAuth + API) to a local fake provider server at
    # this origin, e.g. ``http://127.0.0.1:9911``. Refused in production. Never set on a real
    # server.
    calendar_fake_provider_url: str = ""

    # How long (days, at least 30) the change feed keeps *deletion tombstones* (M7-02, changed by
    # SYNC-03e / ADR-0059 D2: upsert rows are never purged, so a new device can always bootstrap
    # from cursor 0). A tombstone older than this is purged by a durable job; a client whose cursor
    # is older than the highest purged tombstone is told to resync rather than handed a feed that
    # could hide a deletion. Idempotency keys are kept for the same period. It does not bound the
    # user's own entity rows - a soft-deleted entity stays a tombstone in its own table.
    change_retention_days: int = 90
    # How often (seconds) the worker runs the change-feed purge.
    change_purge_interval_seconds: int = 3600
    # How long (seconds) a purge job's lock may stay set before it is treated as stale — a worker
    # that crashed mid-purge — so the recurring purge chain restarts.
    change_purge_stale_seconds: int = 900

    # How often (seconds) the worker sweeps reminders: materialises reminders from task due dates
    # and re-queues any delivery missed while the worker was down (M8-01). A reminder's own delivery
    # job fires at its exact instant, so this only bounds self-healing latency.
    reminder_scan_seconds: int = 60
    # How long (seconds) a reminder sweep's lock may stay set before it is treated as stale — a
    # worker that crashed mid-sweep — so the recurring sweep chain restarts.
    reminder_scan_stale_seconds: int = 900

    # Backups (M9-01). A durable job writes one backup set per run to ``backup_dir`` capturing both
    # durable stores (a PostgreSQL dump + an archive of the notes root) with a checksummed manifest.
    # ``backup_retain`` keeps the newest N published sets; older ones are pruned.
    backup_dir: str = "./data/backups"
    backup_retain: int = 7
    # How often (seconds) the worker produces a backup, and how long a run's durable lock may stay
    # set before it is treated as stale (a worker that crashed mid-backup) so the chain restarts.
    backup_interval_seconds: int = 86400
    backup_stale_seconds: int = 3600
    # Where ``pg_dump`` is executed: a local client (the container image installs one), or — when
    # ``backup_pg_dump_container`` names a running PostgreSQL container — inside that container via
    # ``docker exec`` (useful on a host with no local client). The password is never passed on the
    # command line (see atlas/backups/pgdump.py).
    backup_pg_dump_binary: str = "pg_dump"
    backup_pg_dump_container: str = ""

    # Full data export (M9-03). The default destination for the operator ``atlas-export`` CLI; the
    # API's ``GET /api/export`` streams a zip and does not use it. A portability artifact, distinct
    # from the backups above (ADR-0042).
    export_dir: str = "./data/exports"

    # Web Push (M8-02). VAPID application-server keys (RFC 8292): the **private** key signs each
    # push and is a secret that must never be committed, bundled or logged (AGENTS.md §11); the
    # **public** key is handed to the browser so it can form a subscription. ``vapid_subject`` is
    # the contact (``mailto:`` or ``https:``) a push service may use for the sender. When any of the
    # three is unset, Web Push is disabled cleanly and reminders degrade to the internal log channel
    # (no crash). Generate a pair once and provide it via the environment — see
    # ``docs/DEPLOYMENT.md`` §"Web Push (VAPID keys)".
    vapid_public_key: str = ""
    vapid_private_key: str = ""
    vapid_subject: str = ""

    # Live updates and sync hints (M8-04e, ADR-0068; SYNC_PROTOCOL.md 14.7, 14.8).
    # ``GET /api/sync/wait`` is a long poll: it holds a request up to ``sync_wait_max_seconds``
    # (below nginx's 60 s ``proxy_read_timeout``), re-reading the caller's feed head every
    # ``sync_wait_poll_seconds``; at most ``sync_wait_max_connections`` waits per user are held.
    sync_wait_max_seconds: int = Field(default=25, ge=1, le=55)
    sync_wait_poll_seconds: float = 2.0
    sync_wait_max_connections: int = Field(default=4, ge=1, le=16)
    # The optional content-free "sync now" hint to a self-hosted UnifiedPush gateway (ntfy). Off by
    # default: with ``sync_hint_enabled`` false nothing is sent and no endpoint is accepted. The
    # gateway **origin** is operator configuration only; a device may register only an endpoint
    # whose scheme, host and port equal it exactly. ``sync_hint_gateway_token`` is an optional
    # publish credential (a secret, sent only to that origin, never logged). ``http`` is refused
    # unless ``sync_hint_allow_insecure_http`` is set (a LAN or tailnet gateway) or the environment
    # is not production and the host is loopback.
    sync_hint_enabled: bool = False
    sync_hint_gateway_url: str = ""
    sync_hint_gateway_token: str = ""
    sync_hint_allow_insecure_http: bool = False
    sync_hint_min_interval_seconds: int = Field(default=30, ge=1)
    sync_hint_timeout_seconds: float = Field(default=5.0, gt=0, le=30)
    sync_hint_on_reminder: bool = True

    session_cookie_name: str = "atlas_session"
    csrf_cookie_name: str = "atlas_csrf"
    session_ttl_seconds: int = 60 * 60 * 24 * 14
    auth_rate_limit_per_minute: int = 10
    # Account recovery by one-time code (AUTH-01, ADR-0067). When false, no code is issued at setup,
    # the "forgot password" endpoint and Settings regeneration answer 404, and the owner recovers
    # with ``atlas-admin reset-password`` on the server only.
    recovery_enabled: bool = True

    cors_origins: Annotated[list[str], NoDecode] = Field(default_factory=list)
    # When non-empty, only these Host header values are accepted (production hardening).
    allowed_hosts: Annotated[list[str], NoDecode] = Field(default_factory=list)

    @field_validator("cors_origins", "allowed_hosts", mode="before")
    @classmethod
    def _split_list(cls, value: object) -> object:
        """Accept the documented comma-separated form (``a.example,b.example``) and a JSON list."""
        if isinstance(value, str):
            text = value.strip()
            if text.startswith("["):
                return json.loads(text)
            return [item.strip() for item in text.split(",") if item.strip()]
        return value

    @field_validator("public_base_url")
    @classmethod
    def _strip_trailing_slash(cls, value: str) -> str:
        return value.rstrip("/")

    @field_validator(
        "change_retention_days",
        "change_purge_interval_seconds",
        "note_history_keep_revisions",
        "note_history_keep_days",
        "note_history_max_revisions",
        "note_history_max_bytes",
        "reminder_scan_seconds",
        "backup_retain",
        "backup_interval_seconds",
        "backup_stale_seconds",
    )
    @classmethod
    def _must_be_positive(cls, value: int) -> int:
        if value < 1:
            msg = "retention/interval and backup settings must be positive"
            raise ValueError(msg)
        return value

    @field_validator("change_retention_days")
    @classmethod
    def _retention_at_least_a_month(cls, value: int) -> int:
        if value < MIN_RETENTION_DAYS:
            msg = f"CHANGE_RETENTION_DAYS must be at least {MIN_RETENTION_DAYS}"
            raise ValueError(msg)
        return value

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
        for name, reason in (
            ("calendar_fake_provider_url", "routes calendar OAuth to a fake provider"),
            ("ics_allow_private_hosts", "lets ICS feeds reach private networks (SSRF)"),
        ):
            if getattr(self, name):
                msg = f"{name.upper()} must not be set in production: it {reason}"
                raise RuntimeError(msg)


@lru_cache
def get_settings() -> Settings:
    return Settings()
