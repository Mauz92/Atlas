"""Calendar credentials and sync-status API (M5-01, M5-08).

Two related surfaces:

- **Credentials (M5-01)** — minimal encrypted-store API: write (create/replace), read metadata,
  record a token refresh, and delete. The OAuth flows and provider adapters that *produce* the
  tokens are M5-02/M5-03/M5-04 and make no appearance here.
- **Sync status + manual trigger (M5-08)** — ``GET /api/calendar/sync-status`` derives, per
  provider/calendar, whether the account is connected, the last successful sync, the derived state
  and the last error, from the M5-06 cursor rows (never a parallel store); ``POST
  /api/calendar/providers/{provider}/sync`` runs one read-only pass over the M5-02 registry seam.

Security posture (SECURITY.md T2):

- Every endpoint requires an authenticated session (``CurrentUser``) and unsafe methods need CSRF,
  applied by the shared middleware.
- Token material is accepted only on write, encrypted immediately by the service, and **never**
  returned: responses carry only :class:`~atlas.calendar.CredentialMetadata`.
- The sync-status response carries counts and a content-free error message only — never a token, a
  ciphertext or a raw cursor value.
- Deletion is scoped to the caller; another user's credential is a ``404``.
"""

from __future__ import annotations

from typing import Annotated, NoReturn

from fastapi import APIRouter, Depends, HTTPException, Response, status

from ..calendar import (
    AdapterRegistry,
    CalendarSyncStatus,
    CredentialDecryptionError,
    CredentialMetadata,
    CredentialNotFoundError,
    CredentialProvider,
    CredentialValidationError,
    ProviderCredentialsService,
    ProviderError,
    ProviderSyncOutcome,
    ProviderSyncService,
    ProviderSyncStatus,
    SyncStatusService,
    TokenBundle,
    UnknownProviderError,
    default_registry,
)
from .deps import CurrentUser, DbSession
from .schemas import (
    CalendarCursorStatusOut,
    CalendarSyncResultOut,
    CalendarSyncStatusOut,
    ProviderCredentialListOut,
    ProviderCredentialOut,
    ProviderCredentialRefreshRequest,
    ProviderCredentialUpsertRequest,
    ProviderSyncOut,
    ProviderSyncStatusOut,
)

router = APIRouter(prefix="/api/calendar", tags=["calendar"])


def _translate(exc: Exception) -> NoReturn:
    """Map credential-domain errors onto HTTP responses; re-raise anything unexpected."""
    if isinstance(exc, CredentialNotFoundError):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found") from exc
    if isinstance(exc, CredentialValidationError):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    if isinstance(exc, CredentialDecryptionError):
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="stored credential could not be decrypted",
        ) from exc
    raise exc


def credential_out(metadata: CredentialMetadata) -> ProviderCredentialOut:
    """Serialise credential metadata. Never includes tokens or ciphertext."""
    return ProviderCredentialOut(
        provider=metadata.provider,
        key_id=metadata.key_id,
        scopes=list(metadata.scopes),
        access_expires_at=metadata.access_expires_at,
        refresh_expires_at=metadata.refresh_expires_at,
        has_refresh_token=metadata.has_refresh_token,
        created_at=metadata.created_at,
        updated_at=metadata.updated_at,
    )


@router.get("/credentials", response_model=ProviderCredentialListOut)
async def list_credentials(user: CurrentUser, session: DbSession) -> ProviderCredentialListOut:
    """List the caller's stored credentials (metadata only), ordered by provider."""
    service = ProviderCredentialsService(session, user.id)
    try:
        metadata = await service.list_metadata()
    except Exception as exc:
        _translate(exc)
    return ProviderCredentialListOut(credentials=[credential_out(item) for item in metadata])


@router.get("/credentials/{provider}", response_model=ProviderCredentialOut)
async def get_credential(
    provider: CredentialProvider, user: CurrentUser, session: DbSession
) -> ProviderCredentialOut:
    """Return metadata for one stored credential; ``404`` when none exists for the caller."""
    service = ProviderCredentialsService(session, user.id)
    try:
        metadata = await service.describe(provider)
    except Exception as exc:
        _translate(exc)
    return credential_out(metadata)


@router.put("/credentials/{provider}", response_model=ProviderCredentialOut)
async def upsert_credential(
    provider: CredentialProvider,
    payload: ProviderCredentialUpsertRequest,
    user: CurrentUser,
    session: DbSession,
) -> ProviderCredentialOut:
    """Store (create or replace) the caller's credential for ``provider``.

    Naturally idempotent — one credential per ``(user, provider)`` — so no ``Idempotency-Key`` is
    needed. The tokens are encrypted before the row is written; the response is metadata only.
    """
    service = ProviderCredentialsService(session, user.id)
    try:
        metadata = await service.upsert(
            provider,
            tokens=TokenBundle(
                access_token=payload.access_token,
                refresh_token=payload.refresh_token,
                token_type=payload.token_type,
            ),
            scopes=payload.scopes,
            access_expires_at=payload.access_expires_at,
            refresh_expires_at=payload.refresh_expires_at,
        )
    except Exception as exc:
        _translate(exc)
    await session.commit()
    return credential_out(metadata)


@router.post("/credentials/{provider}/refresh", response_model=ProviderCredentialOut)
async def refresh_credential(
    provider: CredentialProvider,
    payload: ProviderCredentialRefreshRequest,
    user: CurrentUser,
    session: DbSession,
) -> ProviderCredentialOut:
    """Record the result of an OAuth token refresh for an existing credential.

    This endpoint does **not** contact the provider — the refresh exchange belongs to the adapter
    (M5-03/M5-04). It stores the new tokens/expiry the caller already obtained. ``404`` when no
    credential exists.
    """
    service = ProviderCredentialsService(session, user.id)
    try:
        metadata = await service.refresh(
            provider,
            access_token=payload.access_token,
            refresh_token=payload.refresh_token,
            scopes=payload.scopes,
            access_expires_at=payload.access_expires_at,
            refresh_expires_at=payload.refresh_expires_at,
        )
    except Exception as exc:
        _translate(exc)
    await session.commit()
    return credential_out(metadata)


@router.delete("/credentials/{provider}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_credential(
    provider: CredentialProvider, user: CurrentUser, session: DbSession
) -> Response:
    """Delete the caller's credential for ``provider``; ``404`` when none exists."""
    try:
        await ProviderCredentialsService(session, user.id).delete(provider)
    except Exception as exc:
        _translate(exc)
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --- Sync status + manual trigger (M5-08) ---------------------------------


def get_adapter_registry() -> AdapterRegistry:
    """The process-wide adapter registry.

    Overridable via ``app.dependency_overrides`` so a test can inject the M5-02 fake seam; the real
    Google/Microsoft factories register here once M5-03/M5-04 land.
    """
    return default_registry()


AdapterRegistryDep = Annotated[AdapterRegistry, Depends(get_adapter_registry)]


def _translate_sync(exc: Exception) -> NoReturn:
    """Map sync/trigger errors onto HTTP responses without leaking provider or token material."""
    if isinstance(exc, CredentialNotFoundError):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="provider is not connected"
        ) from exc
    if isinstance(exc, CredentialDecryptionError):
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="stored credential could not be decrypted",
        ) from exc
    if isinstance(exc, CredentialValidationError):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    if isinstance(exc, UnknownProviderError):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="calendar sync is not available for this provider",
        ) from exc
    if isinstance(exc, ProviderError):
        # Provider-error messages are content-free by construction (ADR-0028): no token, no payload.
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc) or "calendar sync failed"
        ) from exc
    raise exc


def cursor_status_out(item: CalendarSyncStatus) -> CalendarCursorStatusOut:
    """Serialise one calendar's derived status. Never includes a cursor value."""
    return CalendarCursorStatusOut(
        calendar_id=item.calendar_id,
        state=item.state,
        cursor_health=item.cursor_health,
        cursor_type=item.cursor_type,
        has_cursor=item.has_cursor,
        last_success_at=item.last_success_at,
        last_error=item.last_error,
        last_error_at=item.last_error_at,
    )


def provider_status_out(item: ProviderSyncStatus) -> ProviderSyncStatusOut:
    """Serialise one provider's rolled-up status and its calendars."""
    return ProviderSyncStatusOut(
        provider=item.provider,
        connected=item.connected,
        state=item.state,
        last_success_at=item.last_success_at,
        last_error=item.last_error,
        last_error_at=item.last_error_at,
        calendars=[cursor_status_out(calendar) for calendar in item.calendars],
    )


def provider_sync_out(outcome: ProviderSyncOutcome) -> ProviderSyncOut:
    """Serialise a manual-sync outcome as counts (never a cursor value or event content)."""
    return ProviderSyncOut(
        provider=outcome.provider,
        calendars=[
            CalendarSyncResultOut(
                calendar_id=item.calendar_id,
                pages=item.pages,
                events_seen=item.events_seen,
                deletions_seen=item.deletions_seen,
                created=item.created,
                updated=item.updated,
                unchanged=item.unchanged,
                tombstoned=item.tombstoned,
                cursor_advanced=item.cursor_advanced,
            )
            for item in outcome.calendars
        ],
    )


@router.get("/sync-status", response_model=CalendarSyncStatusOut)
async def sync_status(user: CurrentUser, session: DbSession) -> CalendarSyncStatusOut:
    """The caller's calendar sync status, derived from the M5-06 cursor store.

    Per provider/calendar it reports ``connected``, ``last_success_at`` (UTC), the derived ``state``
    (``never_synced`` | ``idle`` | ``error``), ``cursor_health`` and the last error (a bounded,
    content-free message). Read-only and strictly user-scoped; it never contacts a provider.
    """
    providers = await SyncStatusService(session, user.id).status()
    return CalendarSyncStatusOut(providers=[provider_status_out(item) for item in providers])


@router.post("/providers/{provider}/sync", response_model=ProviderSyncOut)
async def sync_provider(
    provider: CredentialProvider,
    user: CurrentUser,
    session: DbSession,
    registry: AdapterRegistryDep,
) -> ProviderSyncOut:
    """Trigger one read-only sync for ``provider``, reusing the M5-06 service.

    Naturally idempotent — a repeat re-applies the same changes on the projection's unique keys and
    never duplicates an event — so no ``Idempotency-Key`` is required. It builds the adapter through
    the M5-02 registry seam: a provider with no adapter (M5-03/M5-04 pending M5-00/AR-001) is a
    ``503`` and a provider the caller has not connected a ``409``. It never contacts a provider
    itself, and the response carries counts only — never a cursor value or event content.
    """
    service = ProviderSyncService(session, user.id, registry=registry)
    try:
        outcome = await service.sync_provider(provider)
    except Exception as exc:
        _translate_sync(exc)
    return provider_sync_out(outcome)
