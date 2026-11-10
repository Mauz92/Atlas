"""Update the server from the web app (REL-01, ADR-0074).

The API cannot and must not run Docker. It only exchanges two small files with the host updater
through the shared update directory: it reads ``status.json`` (written by the host) and writes
``request.json`` (a systemd path unit then starts the updater, which re-validates the request
against GitHub). A request can only name the release the host has itself reported as the newest,
so a stolen session cannot choose a version. Browser sessions only: a device token is refused
(``CurrentUser``).
"""

from __future__ import annotations

import json
import logging
import os
import re
import tempfile
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from .. import __version__
from ..config import get_settings
from .deps import CurrentUser

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/system/update", tags=["system"])

_VERSION = re.compile(r"^\d{1,4}\.\d{1,5}\.\d{1,5}$")
NOT_SET_UP = "Updating from the web app is not set up on this server."
_STATES = {"idle", "updating", "rolled_back", "failed"}


class UpdateStatus(BaseModel):
    configured: bool
    current_version: str
    state: Literal["idle", "updating", "rolled_back", "failed"] = "idle"
    phase: str | None = None
    latest_version: str | None = None
    update_available: bool = False
    notes: str = ""
    checked_at: str | None = None
    started_at: str | None = None
    finished_at: str | None = None
    message: str = ""
    log: list[str] = Field(default_factory=list)
    request_pending: bool = False


class ApplyRequest(BaseModel):
    version: str = Field(pattern=r"^\d{1,4}\.\d{1,5}\.\d{1,5}$")


def _dir() -> Path | None:
    configured = get_settings().update_dir
    if not configured:
        return None
    path = Path(configured)
    return path if path.is_dir() else None


def _text(value: object, limit: int) -> str:
    return value[:limit] if isinstance(value, str) else ""


def _read(directory: Path | None) -> UpdateStatus:
    if directory is None:
        return UpdateStatus(configured=False, current_version=__version__)
    raw: dict[str, object] = {}
    try:
        loaded = json.loads((directory / "status.json").read_text())
        if isinstance(loaded, dict):
            raw = loaded
    except (OSError, ValueError):
        pass
    state = raw.get("state")
    latest = raw.get("latest")
    log = raw.get("log")
    return UpdateStatus(
        configured=True,
        current_version=__version__,
        state=state if isinstance(state, str) and state in _STATES else "idle",
        phase=_text(raw.get("phase"), 40) or None,
        latest_version=latest if isinstance(latest, str) and _VERSION.match(latest) else None,
        update_available=raw.get("update_available") is True,
        notes=_text(raw.get("notes"), 4000),
        checked_at=_text(raw.get("checked_at"), 40) or None,
        started_at=_text(raw.get("started_at"), 40) or None,
        finished_at=_text(raw.get("finished_at"), 40) or None,
        message=_text(raw.get("message"), 600),
        log=[_text(line, 300) for line in log[-40:]] if isinstance(log, list) else [],
        request_pending=(directory / "request.json").exists(),
    )


def _write_request(directory: Path, body: dict[str, str]) -> None:
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".request-")
    with os.fdopen(fd, "w") as handle:
        json.dump(body, handle)
    os.chmod(tmp, 0o664)  # the host updater runs as another user in the same group
    os.replace(tmp, directory / "request.json")


@router.get("", response_model=UpdateStatus)
async def update_status(_user: CurrentUser) -> UpdateStatus:
    return _read(_dir())


@router.post("/check", response_model=UpdateStatus, status_code=status.HTTP_202_ACCEPTED)
async def check_for_update(_user: CurrentUser) -> UpdateStatus:
    directory = _dir()
    current = _read(directory)
    if directory is None:
        raise HTTPException(status.HTTP_409_CONFLICT, NOT_SET_UP)
    if current.state == "updating" or current.request_pending:
        raise HTTPException(status.HTTP_409_CONFLICT, "An update or check is already in progress.")
    _write_request(directory, {"action": "check"})
    return _read(directory)


@router.post("/apply", response_model=UpdateStatus, status_code=status.HTTP_202_ACCEPTED)
async def apply_update(body: ApplyRequest, user: CurrentUser) -> UpdateStatus:
    directory = _dir()
    current = _read(directory)
    if directory is None:
        raise HTTPException(status.HTTP_409_CONFLICT, NOT_SET_UP)
    if current.state == "updating" or current.request_pending:
        raise HTTPException(status.HTTP_409_CONFLICT, "An update is already in progress.")
    if not current.update_available or body.version != current.latest_version:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "That is not the newest release the server found; check for updates again.",
        )
    _write_request(directory, {"action": "apply", "version": body.version})
    logger.info("server update to %s requested by user %s", body.version, user.id)
    return _read(directory)
