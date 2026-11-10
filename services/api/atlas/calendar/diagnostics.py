"""Read-only calendar diagnostics for the operator CLI (``atlas-admin calendar-status``).

Prints what is needed to diagnose a calendar connection - configuration, connection state, token
*expiry* (never a token), granted scopes, calendars, cursor state, last success/error and event
counts - and nothing that is secret or personal: no token, no ciphertext, no feed URL, no event
title, no provider calendar id. Nothing is written and no provider is contacted.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import get_settings
from ..models import CalendarSource, ExternalEvent, ProviderCredential, SyncCursor, User
from .oauth import OAUTH_PROVIDERS, provider_setup, startup_problems


def _when(value: datetime | None) -> str:
    return value.astimezone(UTC).isoformat(timespec="seconds") if value else "never"


async def render_calendar_status(session: AsyncSession, email: str | None = None) -> list[str]:
    settings = get_settings()
    lines = [
        "Calendar configuration",
        f"  PUBLIC_BASE_URL        {settings.public_base_url}",
        f"  ICS poll interval      {settings.ics_poll_seconds}s"
        f" (reconcile scan {settings.calendar_reconcile_seconds}s)",
    ]
    for provider in OAUTH_PROVIDERS:
        setup = provider_setup(provider, settings)
        state = "configured" if setup.configured else "NOT configured: " + ", ".join(setup.problems)
        lines.append(f"  {provider:<10} {state}")
        lines.append(f"             redirect URI {setup.redirect_uri}")
    for problem in startup_problems(settings):
        lines.append(f"  warning: {problem}")

    users = select(User).where(User.is_active.is_(True)).order_by(User.email)
    if email:
        users = users.where(func.lower(User.email) == email.strip().lower())
    for user in await session.scalars(users):
        lines.append("")
        lines.append(f"Account {user.email}")
        credentials = {
            row.provider: row
            for row in await session.scalars(
                select(ProviderCredential).where(ProviderCredential.user_id == user.id)
            )
        }
        sources = [
            *await session.scalars(
                select(CalendarSource)
                .where(CalendarSource.user_id == user.id)
                .order_by(CalendarSource.provider, CalendarSource.name)
            )
        ]
        cursors = {
            (c.provider, c.calendar_id): c
            for c in await session.scalars(select(SyncCursor).where(SyncCursor.user_id == user.id))
        }
        counts = {
            (row[0], row[1]): row[2]
            for row in (
                await session.execute(
                    select(ExternalEvent.provider, ExternalEvent.calendar_id, func.count())
                    .where(ExternalEvent.user_id == user.id, ExternalEvent.deleted_at.is_(None))
                    .group_by(ExternalEvent.provider, ExternalEvent.calendar_id)
                )
            ).all()
        }
        for provider in (*OAUTH_PROVIDERS, "ics"):
            credential = credentials.get(provider)
            mine = [s for s in sources if s.provider == provider]
            if credential is None and not mine:
                lines.append(f"  {provider}: not connected")
                continue
            header = f"  {provider}: " + (
                "connected" if provider != "ics" else f"{len(mine)} feed(s)"
            )
            if credential is not None:
                header += f", scopes [{', '.join(credential.scopes)}]"
                header += f", access token expires {_when(credential.access_expires_at)}"
                if credential.needs_reauth_at:
                    header += f", NEEDS RE-AUTHORISATION since {_when(credential.needs_reauth_at)}"
            lines.append(header)
            for index, source in enumerate(mine, start=1):
                cursor = cursors.get((source.provider, source.external_id))
                label = f"feed #{index}" if provider == "ics" else f"calendar #{index}"
                line = (
                    f"    {label} [{'shown' if source.selected else 'hidden'}]"
                    f" events={counts.get((source.provider, source.external_id), 0)}"
                )
                if cursor is not None:
                    has_cursor = "set" if cursor.cursor_value else "none"
                    line += f" last_success={_when(cursor.last_success_at)} cursor={has_cursor}"
                    if cursor.last_error:
                        shown = cursor.last_error[:200]
                        line += f" last_error={shown!r} at {_when(cursor.last_error_at)}"
                else:
                    line += " never synced"
                lines.append(line)
    return lines


async def run_calendar_status(email: str | None, out: Callable[[str], None] = print) -> int:
    from ..db import session_scope

    async with session_scope() as session:
        for line in await render_calendar_status(session, email):
            out(line)
    return 0
