"""Optional feature switches (TTRPG-01).

``GET /api/features`` reports every optional feature for the caller (a missing switch is ``false``);
``PUT /api/features/{feature}`` switches one on or off. Switching is idempotent and strictly
per-user. Disabling hides the feature and blocks its endpoints but never deletes its data.
Reading the switches is open to device credentials, so the desktop and Android apps can show or hide
an optional feature (ADR-0084, a deliberate entry in the ``test_devices`` contract). Changing a
switch stays browser-only: turn a module on or off in the browser.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, ConfigDict

from ..features import KNOWN_FEATURES, feature_states, set_enabled
from .deps import CurrentUser, DbSession, SyncUser

router = APIRouter(prefix="/api/features", tags=["features"])


class FeaturesOut(BaseModel):
    ttrpg: bool


class FeatureUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool


def _out(states: dict[str, bool]) -> FeaturesOut:
    return FeaturesOut(ttrpg=states["ttrpg"])


@router.get("", response_model=FeaturesOut)
async def get_features(user: SyncUser, session: DbSession) -> FeaturesOut:
    return _out(await feature_states(session, user.id))


@router.put("/{feature}", response_model=FeaturesOut)
async def put_feature(
    feature: str, payload: FeatureUpdate, user: CurrentUser, session: DbSession
) -> FeaturesOut:
    if feature not in KNOWN_FEATURES:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    await set_enabled(session, user.id, feature, payload.enabled)
    return _out(await feature_states(session, user.id))
