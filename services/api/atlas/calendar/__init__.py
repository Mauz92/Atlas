"""Calendar subsystem (Milestone 5).

Provider code stays inside this package (AGENTS.md §7.3):

- **M5-01** — the encrypted OAuth credential store (:mod:`atlas.calendar.credentials`;
  :class:`~atlas.calendar.tokens.StoredCredential` holds the decrypted tokens an adapter needs).
- **M5-02** — the provider-neutral adapter contract (:mod:`atlas.calendar.adapter`), the neutral
  data types (:mod:`atlas.calendar.types`), the provider-error taxonomy
  (:mod:`atlas.calendar.errors`) and an in-memory fake (:mod:`atlas.calendar.fake`).
- Later tasks add the real Google/Microsoft adapters (M5-03/M5-04) and the projection store (M5-06).
"""

from ..models import CredentialProvider
from .adapter import (
    AdapterFactory,
    AdapterRegistry,
    CalendarAdapter,
    build_adapter,
    canonical_provider,
    default_registry,
)
from .credentials import ProviderCredentialsService
from .crypto import DecryptionError, TokenCipher, get_token_cipher
from .errors import (
    AdapterError,
    AuthExpiredError,
    CredentialDecryptionError,
    CredentialError,
    CredentialNotFoundError,
    CredentialValidationError,
    PermanentProviderError,
    ProviderError,
    RateLimitedError,
    RetryDisposition,
    TransientProviderError,
    UnknownProviderError,
    retry_delay_for,
)
from .fake import DEFAULT_PAGE_SIZE, FakeCalendarAdapter, fake_adapter_factory
from .projection import (
    ProjectionState,
    event_is_unchanged,
    merge_event_row,
    projected_values,
)
from .reconcile import (
    CalendarDueState,
    CalendarReconciliationService,
    ReconciledCalendar,
    ReconciliationSummary,
    begin_sync_run,
    end_sync_run,
    is_due,
    last_terminal_at,
    marker_is_active,
)
from .status import (
    CalendarSyncOutcome,
    CalendarSyncStatus,
    CursorHealth,
    ProviderSyncOutcome,
    ProviderSyncService,
    ProviderSyncStatus,
    SyncState,
    SyncStatusService,
    classify_cursor,
    rollup_provider,
)
from .sync import CalendarSyncService, SyncResult
from .tokens import (
    MAX_SCOPE_COUNT,
    MAX_SCOPE_LENGTH,
    MAX_TOKEN_LENGTH,
    MAX_TOKEN_TYPE_LENGTH,
    CredentialMetadata,
    StoredCredential,
    TokenBundle,
    clean_token,
    clean_token_type,
    ensure_bundle_has_token,
    normalise_expiry,
    normalise_provider,
    normalise_scopes,
)
from .types import Calendar, CursorType, Event, EventDeletion, EventPage, EventStatus

__all__ = [
    "DEFAULT_PAGE_SIZE",
    "MAX_SCOPE_COUNT",
    "MAX_SCOPE_LENGTH",
    "MAX_TOKEN_LENGTH",
    "MAX_TOKEN_TYPE_LENGTH",
    "AdapterError",
    "AdapterFactory",
    "AdapterRegistry",
    "AuthExpiredError",
    "Calendar",
    "CalendarAdapter",
    "CalendarDueState",
    "CalendarReconciliationService",
    "CalendarSyncOutcome",
    "CalendarSyncService",
    "CalendarSyncStatus",
    "CredentialDecryptionError",
    "CredentialError",
    "CredentialMetadata",
    "CredentialNotFoundError",
    "CredentialProvider",
    "CredentialValidationError",
    "CursorHealth",
    "CursorType",
    "DecryptionError",
    "Event",
    "EventDeletion",
    "EventPage",
    "EventStatus",
    "FakeCalendarAdapter",
    "PermanentProviderError",
    "ProjectionState",
    "ProviderCredentialsService",
    "ProviderError",
    "ProviderSyncOutcome",
    "ProviderSyncService",
    "ProviderSyncStatus",
    "RateLimitedError",
    "ReconciledCalendar",
    "ReconciliationSummary",
    "RetryDisposition",
    "StoredCredential",
    "SyncResult",
    "SyncState",
    "SyncStatusService",
    "TokenBundle",
    "TokenCipher",
    "TransientProviderError",
    "UnknownProviderError",
    "begin_sync_run",
    "build_adapter",
    "canonical_provider",
    "classify_cursor",
    "clean_token",
    "clean_token_type",
    "default_registry",
    "end_sync_run",
    "ensure_bundle_has_token",
    "event_is_unchanged",
    "fake_adapter_factory",
    "get_token_cipher",
    "is_due",
    "last_terminal_at",
    "marker_is_active",
    "merge_event_row",
    "normalise_expiry",
    "normalise_provider",
    "normalise_scopes",
    "projected_values",
    "retry_delay_for",
    "rollup_provider",
]
