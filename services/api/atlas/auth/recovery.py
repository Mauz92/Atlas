"""Account recovery by a one-time recovery code (AUTH-01, ADR-0067).

A self-hosted Atlas has no e-mail service, so the owner keeps a **recovery code** instead: 30
characters of Crockford base32 (150 random bits), shown exactly once, written as six groups of
five. Only a salted HMAC-SHA-256 of it is stored. With 150 random bits a fast keyed hash is as
strong as a slow one (there is nothing to guess), so no Argon2 cost is paid on the unauthenticated
endpoint, which also removes it as a CPU-exhaustion lever.

``reset_password_with_code`` is the whole reset. Every refusal runs the *same statements* in the
same order whether the e-mail is unknown, the account has no code, the code is inactive or wrong
(select the user, lock the code row, compare in constant time against the stored or a dummy hash,
count the failure, commit), so neither the answer nor the work done tells them apart. A success
changes the password, signs out every browser session **and** every device
(``revoke_all_devices``, the one shared function) and replaces the code, in one transaction under
a row lock, so a used (or concurrently used) code cannot be replayed.

The code is never logged, echoed in an error, or stored; audit events carry ids only.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import secrets
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import AuthSession, RecoveryCode, User
from .devices import revoke_all_devices
from .passwords import hash_password

audit = logging.getLogger("atlas.auth.audit")

#: Crockford base32: no I, L, O, U (typed as 1, 1, 0 and refused)
ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
CODE_LENGTH = 30  # 30 x 5 bits = 150 bits
GROUP_SIZE = 5
_LOOKALIKES = str.maketrans({"O": "0", "I": "1", "L": "1"})
_IGNORED = frozenset(" -_\t\r\n\N{NO-BREAK SPACE}")
#: longest raw input looked at (a code with generous spacing is ~45 characters)
MAX_RAW_LENGTH = 128

#: per account (keyed by a hash of the e-mail, so an unknown address behaves the same): this many
#: attempts per window. A wrong guess is hopeless against 150 bits; the cap bounds noise and CPU.
#: It is a sliding window, never a permanent lock.
ACCOUNT_ATTEMPTS = 5
ACCOUNT_WINDOW_SECONDS = 900.0

_DUMMY_SALT = bytes(16)
_DUMMY_HASH = "0" * 64


def generate_code() -> str:
    """A new random code in display form: ``XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX``."""
    raw = "".join(secrets.choice(ALPHABET) for _ in range(CODE_LENGTH))
    return "-".join(raw[i : i + GROUP_SIZE] for i in range(0, CODE_LENGTH, GROUP_SIZE))


def normalize_code(raw: str) -> str | None:
    """The canonical 30 characters of ``raw``, or ``None`` when it cannot be a code.

    Tolerant of case, dashes, spaces and the usual look-alikes (``O`` for ``0``, ``I``/``L`` for
    ``1``); strict about everything else.
    """
    if len(raw) > MAX_RAW_LENGTH:
        return None
    text = "".join(ch for ch in raw.upper() if ch not in _IGNORED).translate(_LOOKALIKES)
    if len(text) != CODE_LENGTH or not text.isascii() or any(ch not in ALPHABET for ch in text):
        return None
    return text


def hash_code(salt: bytes, normalized: str) -> str:
    return hmac.new(salt, normalized.encode("ascii"), hashlib.sha256).hexdigest()


def account_key(email: str) -> str:
    """The throttle key of an account: a hash, so the limiter never holds an address."""
    return hashlib.sha256(email.strip().lower().encode("utf-8")).hexdigest()


class RecoveryRefused(Exception):
    """The reset was refused. Deliberately carries no reason: every refusal looks the same."""


@dataclass(frozen=True, slots=True)
class IssuedCode:
    code: str
    created_at: datetime


@dataclass(frozen=True, slots=True)
class ResetOutcome:
    code: str
    created_at: datetime
    sessions_revoked: int
    devices_revoked: int
    user_id: uuid.UUID


def _event(event: str, **fields: object) -> None:
    audit.info(event, extra={"event": event, **fields})


async def issue_recovery_code(
    session: AsyncSession, user_id: uuid.UUID, *, used: bool = False
) -> IssuedCode:
    """Give the user a new code, replacing any earlier one (which stops working at once).

    The caller commits. ``used`` records that this replaces a code just spent in a reset.
    """
    code = generate_code()
    salt = secrets.token_bytes(16)
    digest = hash_code(salt, normalize_code(code) or "")
    row = (
        await session.execute(
            select(RecoveryCode).where(RecoveryCode.user_id == user_id).with_for_update()
        )
    ).scalar_one_or_none()
    now = datetime.now(UTC)
    if row is None:
        row = RecoveryCode(user_id=user_id, code_salt=salt.hex(), code_hash=digest, created_at=now)
        session.add(row)
    else:
        row.code_salt = salt.hex()
        row.code_hash = digest
        row.created_at = now
    row.failed_attempts = 0
    if used:
        row.last_used_at = now
    await session.flush()
    return IssuedCode(code=code, created_at=now)


async def recovery_status(session: AsyncSession, user_id: uuid.UUID) -> RecoveryCode | None:
    row: RecoveryCode | None = await session.scalar(
        select(RecoveryCode).where(RecoveryCode.user_id == user_id)
    )
    return row


async def apply_password_reset(
    session: AsyncSession, user: User, new_password: str
) -> tuple[int, int]:
    """Set the password and sign out every browser session and every device of the account.

    The one implementation behind ``atlas-admin reset-password`` and the recovery-code reset. The
    caller commits (the change, both revocations and anything else in the transaction stand or
    fall together). Returns ``(sessions revoked, devices revoked)``.
    """
    user.password_hash = hash_password(new_password)
    revoked = await session.execute(
        update(AuthSession)
        .where(AuthSession.user_id == user.id, AuthSession.revoked_at.is_(None))
        .values(revoked_at=datetime.now(UTC))
        .returning(AuthSession.id)
    )
    devices = await revoke_all_devices(session, user.id)
    return len(revoked.all()), devices


async def reset_password_with_code(
    session: AsyncSession, email: str, raw_code: str, new_password: str, *, ip_hash: str
) -> ResetOutcome:
    """Reset the password of ``email`` with its recovery code, or raise :class:`RecoveryRefused`.

    Commits (success and failure alike: a failure records its attempt).
    """
    user = await session.scalar(select(User).where(User.email == email.strip().lower()))
    probe_id = user.id if user is not None else uuid.uuid4()
    row = (
        await session.execute(
            select(RecoveryCode).where(RecoveryCode.user_id == probe_id).with_for_update()
        )
    ).scalar_one_or_none()
    normalized = normalize_code(raw_code)
    salt = bytes.fromhex(row.code_salt) if row is not None else _DUMMY_SALT
    stored = row.code_hash if row is not None else _DUMMY_HASH
    matches = hmac.compare_digest(hash_code(salt, normalized or ""), stored)
    accepted = (
        matches
        and normalized is not None
        and row is not None
        and user is not None
        and user.is_active
    )
    if not accepted:
        # The same statement whether or not the row exists: the answer is identical and so is
        # the work. A counter on a real row is for the owner (Settings), never for an answer.
        await session.execute(
            update(RecoveryCode)
            .where(RecoveryCode.user_id == probe_id)
            .values(failed_attempts=RecoveryCode.failed_attempts + 1)
        )
        await session.commit()
        _event(
            "recovery_reset_refused",
            user_id=str(user.id) if user is not None and row is not None else None,
            ip_hash=ip_hash,
        )
        raise RecoveryRefused
    assert user is not None  # narrowed by ``accepted``
    sessions, devices = await apply_password_reset(session, user, new_password)
    issued = await issue_recovery_code(session, user.id, used=True)
    await session.commit()
    _event(
        "recovery_reset_succeeded",
        user_id=str(user.id),
        ip_hash=ip_hash,
        sessions_revoked=sessions,
        devices_revoked=devices,
    )
    return ResetOutcome(
        code=issued.code,
        created_at=issued.created_at,
        sessions_revoked=sessions,
        devices_revoked=devices,
        user_id=user.id,
    )


def audit_event(event: str, **fields: object) -> None:
    """Record a recovery event (ids and counts only, never a code or a password)."""
    _event(event, **fields)


__all__ = [
    "ACCOUNT_ATTEMPTS",
    "ACCOUNT_WINDOW_SECONDS",
    "IssuedCode",
    "RecoveryRefused",
    "ResetOutcome",
    "account_key",
    "apply_password_reset",
    "audit_event",
    "generate_code",
    "hash_code",
    "issue_recovery_code",
    "normalize_code",
    "recovery_status",
    "reset_password_with_code",
]
