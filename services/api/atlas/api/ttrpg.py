"""TTRPG module routes (TTRPG-01 registration, TTRPG-02 campaigns and sessions).

Every route here sits behind :func:`require_ttrpg`: while the feature is off for the caller the
answer is ``404`` (the feature does not exist for that account), checked on the server for each
request, so hiding the entry points in the UI is never the only protection. A foreign id is
reported exactly like a missing one. The routes are open to device credentials (the desktop and
Android apps use the same screens; ADR-0084) and are online-only: no offline queue.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Annotated, Any, Literal, NoReturn

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from ..config import get_settings
from ..features import TTRPG, is_enabled
from ..models import (
    TtrpgCampaign,
    TtrpgCombatAction,
    TtrpgCreature,
    TtrpgEncounterSlot,
    User,
)
from ..notes import NoteConflictError, NoteNotFoundError, NotesStorage
from ..ttrpg import (
    Ability,
    ActionRequest,
    Attack,
    CampaignFolderTakenError,
    CampaignIdTakenError,
    CampaignNote,
    CampaignNotFoundError,
    CampaignRevisionError,
    CampaignService,
    CampaignValidationError,
    CampaignView,
    CardFields,
    CombatantView,
    CreatureAction,
    CreatureFields,
    CreatureNotFoundError,
    CreatureService,
    CreatureValidationError,
    EncounterNotFoundError,
    EncounterService,
    EncounterValidationError,
    EncounterView,
    MemberView,
    MutationKeyReusedError,
    NewCombatant,
    NoteLinkState,
    NothingToUndoError,
    PartyNotFoundError,
    PartyRevisionError,
    PartyService,
    PartyValidationError,
    PreviousHandoff,
    Resource,
    RunExistsError,
    RunNotFoundError,
    RunService,
    RunValidationError,
    RunView,
    SessionNotFoundError,
    SessionView,
    SlotChanges,
    SlotNotFoundError,
    SlotSpec,
    StateFields,
    Trait,
    UndoConflictError,
    link_markdown,
    rules,
)
from ..ttrpg.srd import (
    ATTRIBUTION,
    HttpSrdCatalog,
    SrdCatalog,
    SrdMalformedError,
    SrdNotFoundError,
    SrdUnavailableError,
)
from .deps import DbSession, SyncUser
from .notes import get_storage


async def require_ttrpg(user: SyncUser, session: DbSession) -> User:
    if not await is_enabled(session, user.id, TTRPG):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    return user


TtrpgUser = Annotated[User, Depends(require_ttrpg)]
Storage = Annotated[NotesStorage, Depends(get_storage)]

router = APIRouter(prefix="/api/ttrpg", tags=["ttrpg"])


class TtrpgStatus(BaseModel):
    enabled: bool = True


@router.get("/status", response_model=TtrpgStatus)
async def ttrpg_status(_user: TtrpgUser) -> TtrpgStatus:
    return TtrpgStatus()


# --- schemas ---------------------------------------------------------------


class TtrpgNoteLinkOut(BaseModel):
    note_id: uuid.UUID | None
    path: str | None
    title: str | None
    #: True when the note was deleted (or never linked): relink or recreate it
    missing: bool


class SessionOut(BaseModel):
    id: uuid.UUID
    campaign_id: uuid.UUID
    title: str
    sequence: int
    session_date: date | None
    status: Literal["planned", "active", "done"]
    revision: int
    note: TtrpgNoteLinkOut


class HandoffOut(BaseModel):
    session_id: uuid.UUID
    title: str
    note: TtrpgNoteLinkOut
    #: the text under "Next session" in the previous session's note, if any
    handoff: str | None


class SessionDetailOut(SessionOut):
    previous: HandoffOut | None


class CampaignOut(BaseModel):
    id: uuid.UUID
    title: str
    rules_preset: str
    book_title: str | None
    folder: str
    archived: bool
    revision: int
    created_at: datetime
    home: TtrpgNoteLinkOut


class CampaignDetailOut(CampaignOut):
    sessions: list[SessionOut]


class CampaignListOut(BaseModel):
    items: list[CampaignOut]


class CampaignCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    #: client-chosen id: retrying a create with the same id never duplicates anything
    id: uuid.UUID | None = None
    title: str = Field(max_length=400)
    folder: str | None = Field(default=None, max_length=512)
    book_title: str | None = Field(default=None, max_length=400)
    rules_preset: str = "dnd5e-2014"


class CampaignUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    base_revision: int = Field(ge=1)
    title: str | None = Field(default=None, max_length=400)
    book_title: str | None = Field(default=None, max_length=400)
    archived: bool | None = None


class SessionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: uuid.UUID | None = None
    title: str | None = Field(default=None, max_length=400)


class SessionUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    base_revision: int = Field(ge=1)
    title: str | None = Field(default=None, max_length=400)
    status: Literal["planned", "active", "done"] | None = None
    session_date: date | None = None


class RelinkRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    #: ``"home"`` or a session id
    target: str = Field(max_length=64)
    #: an existing note to link; omit to recreate the note at its standard path
    note_id: uuid.UUID | None = None


def _link(state: NoteLinkState) -> TtrpgNoteLinkOut:
    return TtrpgNoteLinkOut(
        note_id=state.note_id, path=state.path, title=state.title, missing=state.missing
    )


def _session_out(view: SessionView) -> SessionOut:
    item = view.session
    return SessionOut(
        id=item.id,
        campaign_id=item.campaign_id,
        title=item.title,
        sequence=item.sequence,
        session_date=item.session_date,
        status=item.status,
        revision=item.revision,
        note=_link(view.note),
    )


def _handoff_out(previous: PreviousHandoff) -> HandoffOut:
    return HandoffOut(
        session_id=previous.session_id,
        title=previous.title,
        note=_link(previous.note),
        handoff=previous.handoff,
    )


def _campaign_out(campaign: TtrpgCampaign, home: NoteLinkState) -> CampaignOut:
    return CampaignOut(
        id=campaign.id,
        title=campaign.title,
        rules_preset=campaign.rules_preset,
        book_title=campaign.book_title,
        folder=campaign.folder,
        archived=campaign.archived_at is not None,
        revision=campaign.revision,
        created_at=campaign.created_at,
        home=_link(home),
    )


def _detail_out(view: CampaignView) -> CampaignDetailOut:
    base = _campaign_out(view.campaign, view.home)
    return CampaignDetailOut(**base.model_dump(), sessions=[_session_out(s) for s in view.sessions])


def _translate(exc: Exception) -> NoReturn:
    if isinstance(
        exc,
        (
            CampaignNotFoundError,
            SessionNotFoundError,
            NoteNotFoundError,
            PartyNotFoundError,
            EncounterNotFoundError,
            RunNotFoundError,
            SlotNotFoundError,
            CreatureNotFoundError,
        ),
    ):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found") from exc
    if isinstance(exc, CampaignRevisionError):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"message": str(exc), "current_revision": exc.current_revision},
        ) from exc
    if isinstance(exc, CampaignFolderTakenError):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="another campaign already uses that note folder",
        ) from exc
    if isinstance(exc, CampaignIdTakenError):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="that id is already in use"
        ) from exc
    if isinstance(exc, RunExistsError):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"message": str(exc), "code": "run_exists", "run_id": str(exc.run_id)},
        ) from exc
    if isinstance(exc, PartyRevisionError):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": str(exc),
                "code": "party_stale",
                "member_id": str(exc.member_id),
                "current_revision": exc.current_revision,
            },
        ) from exc
    if isinstance(exc, UndoConflictError):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": "this can no longer be undone: " + str(exc),
                "code": "undo_conflict",
            },
        ) from exc
    if isinstance(exc, MutationKeyReusedError):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"message": str(exc), "code": "mutation_key_reused"},
        ) from exc
    if isinstance(exc, NoteConflictError):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="the note changed since it was read; reload and try again",
        ) from exc
    if isinstance(
        exc,
        (
            CampaignValidationError,
            PartyValidationError,
            EncounterValidationError,
            RunValidationError,
            NothingToUndoError,
        ),
    ):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    raise exc


def _service(session: Any, user: User, storage: NotesStorage) -> CampaignService:
    return CampaignService(session, user.id, storage)


# --- campaigns ---------------------------------------------------------------


@router.get("/campaigns", response_model=CampaignListOut)
async def list_campaigns(
    user: TtrpgUser, session: DbSession, storage: Storage, include_archived: bool = False
) -> CampaignListOut:
    service = _service(session, user, storage)
    campaigns = await service.list_campaigns(include_archived=include_archived)
    states = await service._link_states([c.home_note_id for c in campaigns])
    return CampaignListOut(items=[_campaign_out(c, states[c.home_note_id]) for c in campaigns])


@router.post("/campaigns", response_model=CampaignDetailOut, status_code=status.HTTP_201_CREATED)
async def create_campaign(
    payload: CampaignCreate,
    response: Response,
    user: TtrpgUser,
    session: DbSession,
    storage: Storage,
) -> CampaignDetailOut:
    """Create a campaign with a home note and a first session note (never overwrites a file).

    A retry with the same ``id`` returns the existing campaign (``200``) after completing any
    missing scaffold.
    """
    service = _service(session, user, storage)
    try:
        campaign, created = await service.create_campaign(
            title=payload.title,
            campaign_id=payload.id,
            folder=payload.folder,
            book_title=payload.book_title,
            rules_preset=payload.rules_preset,
        )
        await session.commit()
        view = await service.campaign_view(campaign.id)
    except Exception as exc:
        await session.rollback()
        _translate(exc)
    if not created:
        response.status_code = status.HTTP_200_OK
    return _detail_out(view)


@router.get("/campaigns/{campaign_id}", response_model=CampaignDetailOut)
async def get_campaign(
    campaign_id: uuid.UUID, user: TtrpgUser, session: DbSession, storage: Storage
) -> CampaignDetailOut:
    try:
        return _detail_out(await _service(session, user, storage).campaign_view(campaign_id))
    except Exception as exc:
        _translate(exc)


@router.patch("/campaigns/{campaign_id}", response_model=CampaignDetailOut)
async def update_campaign(
    campaign_id: uuid.UUID,
    payload: CampaignUpdate,
    user: TtrpgUser,
    session: DbSession,
    storage: Storage,
) -> CampaignDetailOut:
    service = _service(session, user, storage)
    try:
        await service.update_campaign(
            campaign_id,
            base_revision=payload.base_revision,
            title=payload.title,
            book_title=payload.book_title
            if "book_title" in payload.model_fields_set
            else "__unset__",
            archived=payload.archived,
        )
        await session.commit()
        return _detail_out(await service.campaign_view(campaign_id))
    except Exception as exc:
        await session.rollback()
        _translate(exc)


@router.post(
    "/campaigns/{campaign_id}/sessions",
    response_model=SessionDetailOut,
    status_code=status.HTTP_201_CREATED,
)
async def add_session(
    campaign_id: uuid.UUID,
    payload: SessionCreate,
    response: Response,
    user: TtrpgUser,
    session: DbSession,
    storage: Storage,
) -> SessionDetailOut:
    service = _service(session, user, storage)
    try:
        row, created = await service.add_session(
            campaign_id, session_id=payload.id, title=payload.title
        )
        await session.commit()
        view = await service.session_view(row.id)
    except Exception as exc:
        await session.rollback()
        _translate(exc)
    if not created:
        response.status_code = status.HTTP_200_OK
    return SessionDetailOut(
        **_session_out(view).model_dump(),
        previous=_handoff_out(view.previous) if view.previous else None,
    )


@router.post("/campaigns/{campaign_id}/relink", response_model=CampaignDetailOut)
async def relink_note(
    campaign_id: uuid.UUID,
    payload: RelinkRequest,
    user: TtrpgUser,
    session: DbSession,
    storage: Storage,
) -> CampaignDetailOut:
    """Repair a missing note link: point it at an existing note, or recreate the note."""
    service = _service(session, user, storage)
    try:
        target: Literal["home"] | uuid.UUID
        if payload.target == "home":
            target = "home"
        else:
            try:
                target = uuid.UUID(payload.target)
            except ValueError as exc:
                raise CampaignValidationError("target must be 'home' or a session id") from exc
        await service.relink(campaign_id, target=target, note_id=payload.note_id)
        await session.commit()
        return _detail_out(await service.campaign_view(campaign_id))
    except Exception as exc:
        await session.rollback()
        _translate(exc)


# --- the campaign's notes, collected -------------------------------------------


class CampaignNoteOut(BaseModel):
    id: uuid.UUID
    path: str
    title: str
    kind: Literal["home", "session", "npc", "location", "other"]
    #: a session note's "1. Session 01"; otherwise null
    label: str | None


class CampaignNotesOut(BaseModel):
    items: list[CampaignNoteOut]


class CampaignNoteCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["npc", "location", "note"]
    title: str = Field(min_length=1, max_length=400)


def _note_item(note: CampaignNote) -> CampaignNoteOut:
    return CampaignNoteOut(
        id=note.id, path=note.path, title=note.title, kind=note.kind, label=note.label
    )


@router.get("/campaigns/{campaign_id}/notes", response_model=CampaignNotesOut)
async def campaign_notes(
    campaign_id: uuid.UUID, user: TtrpgUser, session: DbSession, storage: Storage
) -> CampaignNotesOut:
    """Every note of the campaign in one place: home, sessions, NPCs, locations, the rest.

    They remain ordinary notes in the notes tree; this is the campaign's own view of them.
    """
    try:
        notes = await _service(session, user, storage).campaign_notes(campaign_id)
    except Exception as exc:
        _translate(exc)
    return CampaignNotesOut(items=[_note_item(n) for n in notes])


@router.post(
    "/campaigns/{campaign_id}/notes",
    response_model=CampaignNoteOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_campaign_note(
    campaign_id: uuid.UUID,
    payload: CampaignNoteCreate,
    user: TtrpgUser,
    session: DbSession,
    storage: Storage,
) -> CampaignNoteOut:
    """A new NPC, location or plain note inside the campaign's folder (never overwrites a file)."""
    service = _service(session, user, storage)
    try:
        note = await service.create_campaign_note(
            campaign_id, kind=payload.kind, title=payload.title
        )
        await session.commit()
    except Exception as exc:
        await session.rollback()
        _translate(exc)
    return _note_item(note)


# --- sessions ----------------------------------------------------------------


@router.get("/sessions/{session_id}", response_model=SessionDetailOut)
async def get_session(
    session_id: uuid.UUID, user: TtrpgUser, session: DbSession, storage: Storage
) -> SessionDetailOut:
    """A session with the previous session's written handoff ("Next session" section)."""
    try:
        view = await _service(session, user, storage).session_view(session_id)
    except Exception as exc:
        _translate(exc)
    return SessionDetailOut(
        **_session_out(view).model_dump(),
        previous=_handoff_out(view.previous) if view.previous else None,
    )


@router.patch("/sessions/{session_id}", response_model=SessionDetailOut)
async def update_session(
    session_id: uuid.UUID,
    payload: SessionUpdate,
    user: TtrpgUser,
    session: DbSession,
    storage: Storage,
) -> SessionDetailOut:
    service = _service(session, user, storage)
    try:
        await service.update_session(
            session_id,
            base_revision=payload.base_revision,
            title=payload.title,
            status=payload.status,
            session_date=(
                payload.session_date if "session_date" in payload.model_fields_set else "__unset__"
            ),
        )
        await session.commit()
        view = await service.session_view(session_id)
    except Exception as exc:
        await session.rollback()
        _translate(exc)
    return SessionDetailOut(
        **_session_out(view).model_dump(),
        previous=_handoff_out(view.previous) if view.previous else None,
    )


# --- party (TTRPG-03) ----------------------------------------------------------


class PartyStateOut(BaseModel):
    current_hp: int
    temp_hp: int
    conditions: list[str]
    exhaustion_level: int
    death_save_successes: int
    death_save_failures: int
    resources_used: dict[str, int]
    revision: int


class PartyMemberOut(CardFields):
    model_config = ConfigDict(json_schema_serialization_defaults_required=True)

    id: uuid.UUID
    campaign_id: uuid.UUID
    archived: bool
    revision: int
    state: PartyStateOut


class PartyListOut(BaseModel):
    items: list[PartyMemberOut]
    #: the 2014 condition names the state accepts
    conditions: list[str]


class PartyMemberCreate(CardFields):
    id: uuid.UUID | None = None


class PartyCardUpdate(CardFields):
    base_revision: int = Field(ge=1)


class PartyArchiveRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    base_revision: int = Field(ge=1)
    archived: bool


class PartyStateUpdate(StateFields):
    base_revision: int = Field(ge=1)


class HpAdjustRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    base_revision: int = Field(ge=1)
    kind: Literal["damage", "heal", "temp_hp"]
    amount: int = Field(ge=0, le=9999)


class RestPreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["short", "long"]


class IntChangeOut(BaseModel):
    before: int
    after: int


class RestMemberPreview(BaseModel):
    member_id: uuid.UUID
    name: str
    state_revision: int
    hp: IntChangeOut | None
    temp_hp: IntChangeOut | None
    exhaustion_level: IntChangeOut | None
    death_saves_cleared: bool
    resources_used: dict[str, IntChangeOut]
    #: nothing would change: leave the member out of the confirmation
    unchanged: bool


class RestPreviewOut(BaseModel):
    kind: Literal["short", "long"]
    members: list[RestMemberPreview]
    #: what the preset cannot know (hit dice are not tracked)
    notes: list[str]


class RestConfirmMember(BaseModel):
    model_config = ConfigDict(extra="forbid")

    member_id: uuid.UUID
    base_revision: int = Field(ge=1)
    #: replaces the proposal field by field (HP, temporary HP, exhaustion, resources)
    overrides: StateFields | None = None


class RestApplyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["short", "long"]
    members: list[RestConfirmMember] = Field(max_length=50)


def _member_out(view: MemberView) -> PartyMemberOut:
    member, state = view.member, view.state
    return PartyMemberOut(
        id=member.id,
        campaign_id=member.campaign_id,
        archived=member.archived_at is not None,
        revision=member.revision,
        role=member.role,
        name=member.name,
        level=member.level,
        ac=member.ac,
        max_hp=member.max_hp,
        speed=member.speed,
        initiative_mod=member.initiative_mod,
        passive_perception=member.passive_perception,
        attacks=[Attack(**item) for item in member.attacks],
        abilities=[Ability(**item) for item in member.abilities],
        resources=[Resource(**item) for item in member.resources],
        state=PartyStateOut(
            current_hp=state.current_hp,
            temp_hp=state.temp_hp,
            conditions=list(state.conditions),
            exhaustion_level=state.exhaustion_level,
            death_save_successes=state.death_save_successes,
            death_save_failures=state.death_save_failures,
            resources_used=dict(state.resources_used),
            revision=state.revision,
        ),
    )


def _pair(change: tuple[int, int] | None) -> IntChangeOut | None:
    return IntChangeOut(before=change[0], after=change[1]) if change else None


@router.get("/campaigns/{campaign_id}/party", response_model=PartyListOut)
async def list_party(
    campaign_id: uuid.UUID,
    user: TtrpgUser,
    session: DbSession,
    include_archived: bool = False,
) -> PartyListOut:
    try:
        views = await PartyService(session, user.id).list_members(
            campaign_id, include_archived=include_archived
        )
    except Exception as exc:
        _translate(exc)
    return PartyListOut(items=[_member_out(v) for v in views], conditions=list(rules.CONDITIONS))


@router.post(
    "/campaigns/{campaign_id}/party",
    response_model=PartyMemberOut,
    status_code=status.HTTP_201_CREATED,
)
async def add_party_member(
    campaign_id: uuid.UUID,
    payload: PartyMemberCreate,
    response: Response,
    user: TtrpgUser,
    session: DbSession,
) -> PartyMemberOut:
    """Add a card; a retry with the same ``id`` returns the existing member (``200``)."""
    card = CardFields(**payload.model_dump(exclude={"id"}))
    try:
        view, created = await PartyService(session, user.id).add_member(
            campaign_id, card, member_id=payload.id
        )
        await session.commit()
    except Exception as exc:
        await session.rollback()
        _translate(exc)
    if not created:
        response.status_code = status.HTTP_200_OK
    return _member_out(view)


@router.get("/party/{member_id}", response_model=PartyMemberOut)
async def get_party_member(
    member_id: uuid.UUID, user: TtrpgUser, session: DbSession
) -> PartyMemberOut:
    try:
        return _member_out(await PartyService(session, user.id).get(member_id))
    except Exception as exc:
        _translate(exc)


@router.put("/party/{member_id}", response_model=PartyMemberOut)
async def update_party_card(
    member_id: uuid.UUID, payload: PartyCardUpdate, user: TtrpgUser, session: DbSession
) -> PartyMemberOut:
    """Replace a card (revision-checked). Play state is clamped to the new card, never reset."""
    card = CardFields(**payload.model_dump(exclude={"base_revision"}))
    try:
        view = await PartyService(session, user.id).update_card(
            member_id, card, base_revision=payload.base_revision
        )
        await session.commit()
    except Exception as exc:
        await session.rollback()
        _translate(exc)
    return _member_out(view)


@router.post("/party/{member_id}/archive", response_model=PartyMemberOut)
async def archive_party_member(
    member_id: uuid.UUID, payload: PartyArchiveRequest, user: TtrpgUser, session: DbSession
) -> PartyMemberOut:
    try:
        view = await PartyService(session, user.id).set_archived(
            member_id, payload.archived, base_revision=payload.base_revision
        )
        await session.commit()
    except Exception as exc:
        await session.rollback()
        _translate(exc)
    return _member_out(view)


@router.patch("/party/{member_id}/state", response_model=PartyMemberOut)
async def update_party_state(
    member_id: uuid.UUID, payload: PartyStateUpdate, user: TtrpgUser, session: DbSession
) -> PartyMemberOut:
    """Direct, revision-checked correction of play state (any subset of fields)."""
    changes = StateFields(**payload.model_dump(exclude={"base_revision"}, exclude_unset=True))
    try:
        view = await PartyService(session, user.id).update_state(
            member_id, changes, base_revision=payload.base_revision
        )
        await session.commit()
    except Exception as exc:
        await session.rollback()
        _translate(exc)
    return _member_out(view)


@router.post("/party/{member_id}/hp", response_model=PartyMemberOut)
async def adjust_party_hp(
    member_id: uuid.UUID, payload: HpAdjustRequest, user: TtrpgUser, session: DbSession
) -> PartyMemberOut:
    """Damage (temporary HP first), healing (capped at the maximum) or temporary HP."""
    try:
        view = await PartyService(session, user.id).adjust_hp(
            member_id, payload.kind, payload.amount, base_revision=payload.base_revision
        )
        await session.commit()
    except Exception as exc:
        await session.rollback()
        _translate(exc)
    return _member_out(view)


@router.post("/campaigns/{campaign_id}/rest/preview", response_model=RestPreviewOut)
async def preview_rest(
    campaign_id: uuid.UUID, payload: RestPreviewRequest, user: TtrpgUser, session: DbSession
) -> RestPreviewOut:
    """What a short or long rest would change for each active member. Changes nothing."""
    try:
        previews = await PartyService(session, user.id).preview_rest(campaign_id, payload.kind)
    except Exception as exc:
        _translate(exc)
    notes = ["Hit dice are not tracked: enter hit points recovered by hit dice yourself."]
    return RestPreviewOut(
        kind=payload.kind,
        notes=notes if payload.kind == "short" else [],
        members=[
            RestMemberPreview(
                member_id=view.member.id,
                name=view.member.name,
                state_revision=view.state.revision,
                hp=_pair(change.hp),
                temp_hp=_pair(change.temp_hp),
                exhaustion_level=_pair(change.exhaustion_level),
                death_saves_cleared=change.death_saves_cleared,
                resources_used={
                    key: IntChangeOut(before=pair[0], after=pair[1])
                    for key, pair in change.resources_used.items()
                },
                unchanged=change.is_empty,
            )
            for view, change in previews
        ],
    )


@router.post("/campaigns/{campaign_id}/rest", response_model=PartyListOut)
async def apply_rest(
    campaign_id: uuid.UUID, payload: RestApplyRequest, user: TtrpgUser, session: DbSession
) -> PartyListOut:
    """Apply a confirmed rest to the listed members, all or none (a stale member is a 409)."""
    service = PartyService(session, user.id)
    try:
        await service.apply_rest(
            campaign_id,
            payload.kind,
            [(m.member_id, m.base_revision, m.overrides) for m in payload.members],
        )
        await session.commit()
        views = await service.list_members(campaign_id)
    except Exception as exc:
        await session.rollback()
        _translate(exc)
    return PartyListOut(items=[_member_out(v) for v in views], conditions=list(rules.CONDITIONS))


# --- creatures and the SRD catalogue (TTRPG-04) ---------------------------------

_catalog: SrdCatalog | None = None


def get_srd_catalog() -> SrdCatalog:
    """The catalogue adapter (one per process, so its index cache is shared).

    Tests override this dependency with a fake; production reads the settings.
    """
    global _catalog
    settings = get_settings()
    if not settings.ttrpg_srd_enabled:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="the SRD catalogue is turned off on this server",
        )
    if _catalog is None:
        _catalog = HttpSrdCatalog(
            settings.ttrpg_srd_base_url, timeout=settings.ttrpg_srd_timeout_seconds
        )
    return _catalog


Catalog = Annotated[SrdCatalog, Depends(get_srd_catalog)]


class CreatureOut(CreatureFields):
    model_config = ConfigDict(json_schema_serialization_defaults_required=True)

    id: uuid.UUID
    source: Literal["manual", "srd"]
    source_edition: str | None
    external_id: str | None
    #: required notice for material taken from the SRD; show it wherever the card is shown
    attribution: str | None
    imported_at: datetime | None
    derived_from_id: uuid.UUID | None
    archived: bool
    revision: int


class CreatureListOut(BaseModel):
    items: list[CreatureOut]


class CreatureCreate(CreatureFields):
    id: uuid.UUID | None = None


class CreatureUpdate(CreatureFields):
    base_revision: int = Field(ge=1)


class RevisionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    base_revision: int = Field(ge=1)


class CreatureArchive(RevisionRequest):
    archived: bool


class DuplicateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: uuid.UUID | None = None


class SrdEntryOut(BaseModel):
    index: str
    name: str
    #: the local card when this creature was already imported
    imported_as: uuid.UUID | None


class SrdSearchOut(BaseModel):
    items: list[SrdEntryOut]
    attribution: str


class SrdImportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    index: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{0,99}$")


def _creature_out(row: TtrpgCreature) -> CreatureOut:
    return CreatureOut(
        id=row.id,
        name=row.name,
        ac=row.ac,
        hp=row.hp,
        speed=row.speed,
        initiative_mod=row.initiative_mod,
        challenge_rating=row.challenge_rating,
        size=row.size,
        creature_type=row.creature_type,
        traits=[Trait(**item) for item in row.traits],
        actions=[CreatureAction(**item) for item in row.actions],
        source=row.source,
        source_edition=row.source_edition,
        external_id=row.external_id,
        attribution=row.attribution,
        imported_at=row.imported_at,
        derived_from_id=row.derived_from_id,
        archived=row.archived_at is not None,
        revision=row.revision,
    )


def _translate_creature(exc: Exception) -> NoReturn:
    if isinstance(exc, CreatureNotFoundError):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found") from exc
    if isinstance(exc, SrdNotFoundError):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="That creature is not in the catalogue"
        ) from exc
    if isinstance(exc, (SrdUnavailableError, SrdMalformedError)):
        # Content-free on purpose: no provider URL, body or header is echoed.
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=(
                "The monster catalogue is not available right now. "
                "Manual creature cards still work."
                if isinstance(exc, SrdUnavailableError)
                else "The monster catalogue sent something Atlas could not read."
            ),
        ) from exc
    if isinstance(exc, CreatureValidationError):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    _translate(exc)


@router.get("/creatures", response_model=CreatureListOut)
async def list_creatures(
    user: TtrpgUser,
    session: DbSession,
    q: Annotated[str, Query(max_length=120)] = "",
    include_archived: bool = False,
) -> CreatureListOut:
    rows = await CreatureService(session, user.id).list_cards(
        query=q, include_archived=include_archived
    )
    return CreatureListOut(items=[_creature_out(r) for r in rows])


@router.post("/creatures", response_model=CreatureOut, status_code=status.HTTP_201_CREATED)
async def create_creature(
    payload: CreatureCreate, response: Response, user: TtrpgUser, session: DbSession
) -> CreatureOut:
    """A manual card (name, AC and HP are enough). A retry with the same ``id`` returns it (200)."""
    card = CreatureFields(**payload.model_dump(exclude={"id"}))
    try:
        row, created = await CreatureService(session, user.id).create(card, creature_id=payload.id)
        await session.commit()
    except Exception as exc:
        await session.rollback()
        _translate_creature(exc)
    if not created:
        response.status_code = status.HTTP_200_OK
    return _creature_out(row)


@router.get("/creatures/{creature_id}", response_model=CreatureOut)
async def get_creature(creature_id: uuid.UUID, user: TtrpgUser, session: DbSession) -> CreatureOut:
    try:
        return _creature_out(await CreatureService(session, user.id).get(creature_id))
    except Exception as exc:
        _translate_creature(exc)


@router.put("/creatures/{creature_id}", response_model=CreatureOut)
async def update_creature(
    creature_id: uuid.UUID, payload: CreatureUpdate, user: TtrpgUser, session: DbSession
) -> CreatureOut:
    """Replace a manual card (revision-checked). An imported card must be duplicated first."""
    card = CreatureFields(**payload.model_dump(exclude={"base_revision"}))
    try:
        row = await CreatureService(session, user.id).update(
            creature_id, card, base_revision=payload.base_revision
        )
        await session.commit()
    except Exception as exc:
        await session.rollback()
        _translate_creature(exc)
    return _creature_out(row)


@router.post(
    "/creatures/{creature_id}/duplicate",
    response_model=CreatureOut,
    status_code=status.HTTP_201_CREATED,
)
async def duplicate_creature(
    creature_id: uuid.UUID,
    payload: DuplicateRequest,
    response: Response,
    user: TtrpgUser,
    session: DbSession,
) -> CreatureOut:
    """An editable manual variant of any card (an SRD source keeps its attribution)."""
    try:
        row, created = await CreatureService(session, user.id).duplicate(
            creature_id, new_id=payload.id
        )
        await session.commit()
    except Exception as exc:
        await session.rollback()
        _translate_creature(exc)
    if not created:
        response.status_code = status.HTTP_200_OK
    return _creature_out(row)


@router.post("/creatures/{creature_id}/archive", response_model=CreatureOut)
async def archive_creature(
    creature_id: uuid.UUID, payload: CreatureArchive, user: TtrpgUser, session: DbSession
) -> CreatureOut:
    try:
        row = await CreatureService(session, user.id).set_archived(
            creature_id, payload.archived, base_revision=payload.base_revision
        )
        await session.commit()
    except Exception as exc:
        await session.rollback()
        _translate_creature(exc)
    return _creature_out(row)


@router.post("/creatures/{creature_id}/refresh", response_model=CreatureOut)
async def refresh_creature(
    creature_id: uuid.UUID,
    payload: RevisionRequest,
    user: TtrpgUser,
    session: DbSession,
    catalog: Catalog,
) -> CreatureOut:
    """Re-fetch an imported card from the catalogue: the only way upstream changes reach it."""
    try:
        row = await CreatureService(session, user.id).refresh(
            catalog, creature_id, base_revision=payload.base_revision
        )
        await session.commit()
    except Exception as exc:
        await session.rollback()
        _translate_creature(exc)
    return _creature_out(row)


@router.get("/srd/monsters", response_model=SrdSearchOut)
async def search_srd(
    user: TtrpgUser,
    session: DbSession,
    catalog: Catalog,
    q: Annotated[str, Query(max_length=120)] = "",
) -> SrdSearchOut:
    """Search the SRD monster index by name (the search runs locally on a cached copy)."""
    try:
        entries = await catalog.search(q)
        imported = await CreatureService(session, user.id).imported_ids([e.index for e in entries])
    except Exception as exc:
        _translate_creature(exc)
    return SrdSearchOut(
        items=[
            SrdEntryOut(index=e.index, name=e.name, imported_as=imported.get(e.index))
            for e in entries
        ],
        attribution=ATTRIBUTION,
    )


@router.post("/srd/import", response_model=CreatureOut, status_code=status.HTTP_201_CREATED)
async def import_srd(
    payload: SrdImportRequest,
    response: Response,
    user: TtrpgUser,
    session: DbSession,
    catalog: Catalog,
) -> CreatureOut:
    """Import one SRD creature as a read-only card with provenance. Importing it again returns
    the existing card (200) and does not contact the catalogue."""
    try:
        row, created = await CreatureService(session, user.id).import_srd(catalog, payload.index)
        await session.commit()
    except Exception as exc:
        await session.rollback()
        _translate_creature(exc)
    if not created:
        response.status_code = status.HTTP_200_OK
    return _creature_out(row)


# --- prepared encounters (TTRPG-05) ----------------------------------------------


class SlotOut(BaseModel):
    model_config = ConfigDict(json_schema_serialization_defaults_required=True)

    id: uuid.UUID
    position: int
    side: Literal["enemy", "ally"]
    creature_id: uuid.UUID | None
    name: str
    ac: int
    hp: int
    initiative_mod: int
    #: fields the DM set by hand: a refresh never touches them
    overrides: list[str]
    #: the copied card (traits, actions, provenance and attribution); empty for a custom entry
    snapshot: dict[str, Any]


class EncounterPartyOut(BaseModel):
    id: uuid.UUID
    name: str
    role: str
    #: the member has been retired since this encounter was prepared
    retired: bool


class EncounterSummaryOut(BaseModel):
    id: uuid.UUID
    campaign_id: uuid.UUID
    title: str
    book_reference: str | None
    session_id: uuid.UUID | None
    slot_count: int
    archived: bool
    revision: int


class EncounterListOut(BaseModel):
    items: list[EncounterSummaryOut]


class EncounterOut(BaseModel):
    model_config = ConfigDict(json_schema_serialization_defaults_required=True)

    id: uuid.UUID
    campaign_id: uuid.UUID
    title: str
    book_reference: str | None
    setup_reminder: str | None
    session_id: uuid.UUID | None
    session_title: str | None
    location: TtrpgNoteLinkOut | None
    party: list[EncounterPartyOut]
    slots: list[SlotOut]
    archived: bool
    revision: int
    #: in-app path and Markdown link that open this encounter's prep from a note
    path: str
    link: str


class EncounterCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: uuid.UUID | None = None
    title: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
    book_reference: str | None = Field(default=None, max_length=300)
    setup_reminder: str | None = Field(default=None, max_length=2000)
    session_id: uuid.UUID | None = None
    location_note_id: uuid.UUID | None = None
    party_member_ids: list[uuid.UUID] = Field(default_factory=list, max_length=12)


class EncounterUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    base_revision: int = Field(ge=1)
    title: (
        Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
        | None
    ) = None
    book_reference: str | None = Field(default=None, max_length=300)
    setup_reminder: str | None = Field(default=None, max_length=2000)
    session_id: uuid.UUID | None = None
    location_note_id: uuid.UUID | None = None
    party_member_ids: list[uuid.UUID] | None = Field(default=None, max_length=12)
    archived: bool | None = None


class SlotAddRequest(SlotSpec):
    base_revision: int = Field(ge=1)


class SlotUpdateRequest(SlotChanges):
    base_revision: int = Field(ge=1)


class SlotRefreshOut(BaseModel):
    slot_id: uuid.UUID
    name: str
    outcome: Literal["refreshed", "unchanged", "no_card", "card_archived"]


class EncounterRefreshOut(BaseModel):
    encounter: EncounterOut
    slots: list[SlotRefreshOut]


class NoteLinkResultOut(BaseModel):
    link: str
    #: False when the session note already contained the link
    changed: bool


def _slot_out(slot: TtrpgEncounterSlot) -> SlotOut:
    return SlotOut(
        id=slot.id,
        position=slot.position,
        side=slot.side,
        creature_id=slot.creature_id,
        name=slot.name,
        ac=slot.ac,
        hp=slot.hp,
        initiative_mod=slot.initiative_mod,
        overrides=list(slot.overrides),
        snapshot=dict(slot.snapshot),
    )


def _encounter_out(view: EncounterView) -> EncounterOut:
    e = view.encounter
    return EncounterOut(
        id=e.id,
        campaign_id=e.campaign_id,
        title=e.title,
        book_reference=e.book_reference,
        setup_reminder=e.setup_reminder,
        session_id=e.session_id,
        session_title=view.session_title,
        location=_link(view.location) if view.location else None,
        party=[
            EncounterPartyOut(id=m.id, name=m.name, role=m.role, retired=retired)
            for m, retired in view.party
        ],
        slots=[_slot_out(s) for s in view.slots],
        archived=e.archived_at is not None,
        revision=e.revision,
        path=f"/ttrpg/encounters/{e.id}",
        link=link_markdown(e.id, e.title),
    )


@router.get("/campaigns/{campaign_id}/encounters", response_model=EncounterListOut)
async def list_encounters(
    campaign_id: uuid.UUID,
    user: TtrpgUser,
    session: DbSession,
    storage: Storage,
    session_id: uuid.UUID | None = None,
    include_archived: bool = False,
) -> EncounterListOut:
    try:
        rows = await EncounterService(session, user.id, storage).list_encounters(
            campaign_id, session_id=session_id, include_archived=include_archived
        )
    except Exception as exc:
        _translate(exc)
    return EncounterListOut(
        items=[
            EncounterSummaryOut(
                id=e.id,
                campaign_id=e.campaign_id,
                title=e.title,
                book_reference=e.book_reference,
                session_id=e.session_id,
                slot_count=count,
                archived=e.archived_at is not None,
                revision=e.revision,
            )
            for e, count in rows
        ]
    )


@router.post(
    "/campaigns/{campaign_id}/encounters",
    response_model=EncounterOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_encounter(
    campaign_id: uuid.UUID,
    payload: EncounterCreate,
    response: Response,
    user: TtrpgUser,
    session: DbSession,
    storage: Storage,
) -> EncounterOut:
    """Prepare an encounter; a retry with the same ``id`` returns it (``200``)."""
    service = EncounterService(session, user.id, storage)
    try:
        encounter, created = await service.create(
            campaign_id,
            title=payload.title,
            encounter_id=payload.id,
            book_reference=payload.book_reference,
            setup_reminder=payload.setup_reminder,
            session_id=payload.session_id,
            location_note_id=payload.location_note_id,
            party_member_ids=payload.party_member_ids,
        )
        await session.commit()
        view = await service.view(encounter.id)
    except Exception as exc:
        await session.rollback()
        _translate(exc)
    if not created:
        response.status_code = status.HTTP_200_OK
    return _encounter_out(view)


@router.get("/encounters/{encounter_id}", response_model=EncounterOut)
async def get_encounter(
    encounter_id: uuid.UUID, user: TtrpgUser, session: DbSession, storage: Storage
) -> EncounterOut:
    try:
        return _encounter_out(await EncounterService(session, user.id, storage).view(encounter_id))
    except Exception as exc:
        _translate(exc)


@router.patch("/encounters/{encounter_id}", response_model=EncounterOut)
async def update_encounter(
    encounter_id: uuid.UUID,
    payload: EncounterUpdate,
    user: TtrpgUser,
    session: DbSession,
    storage: Storage,
) -> EncounterOut:
    """Edit prep fields (revision-checked). A field sent as ``null`` clears it where optional."""
    service = EncounterService(session, user.id, storage)
    changes = payload.model_dump(exclude={"base_revision"}, exclude_unset=True)
    try:
        await service.update(encounter_id, base_revision=payload.base_revision, changes=changes)
        await session.commit()
        view = await service.view(encounter_id)
    except Exception as exc:
        await session.rollback()
        _translate(exc)
    return _encounter_out(view)


@router.post("/encounters/{encounter_id}/slots", response_model=EncounterOut)
async def add_encounter_slots(
    encounter_id: uuid.UUID,
    payload: SlotAddRequest,
    user: TtrpgUser,
    session: DbSession,
    storage: Storage,
) -> EncounterOut:
    """Add ``count`` independent slots from a card (or a custom entry). Stats are copied."""
    service = EncounterService(session, user.id, storage)
    spec = SlotSpec(**payload.model_dump(exclude={"base_revision"}))
    try:
        await service.add_slots(encounter_id, spec, base_revision=payload.base_revision)
        await session.commit()
        view = await service.view(encounter_id)
    except Exception as exc:
        await session.rollback()
        _translate(exc)
    return _encounter_out(view)


@router.patch("/encounters/{encounter_id}/slots/{slot_id}", response_model=EncounterOut)
async def update_encounter_slot(
    encounter_id: uuid.UUID,
    slot_id: uuid.UUID,
    payload: SlotUpdateRequest,
    user: TtrpgUser,
    session: DbSession,
    storage: Storage,
) -> EncounterOut:
    """Override a slot's name, AC, HP or initiative modifier for this table."""
    service = EncounterService(session, user.id, storage)
    changes = SlotChanges(**payload.model_dump(exclude={"base_revision"}))
    try:
        await service.update_slot(
            encounter_id, slot_id, changes, base_revision=payload.base_revision
        )
        await session.commit()
        view = await service.view(encounter_id)
    except Exception as exc:
        await session.rollback()
        _translate(exc)
    return _encounter_out(view)


@router.delete("/encounters/{encounter_id}/slots/{slot_id}", response_model=EncounterOut)
async def remove_encounter_slot(
    encounter_id: uuid.UUID,
    slot_id: uuid.UUID,
    base_revision: Annotated[int, Query(ge=1)],
    user: TtrpgUser,
    session: DbSession,
    storage: Storage,
) -> EncounterOut:
    service = EncounterService(session, user.id, storage)
    try:
        await service.remove_slot(encounter_id, slot_id, base_revision=base_revision)
        await session.commit()
        view = await service.view(encounter_id)
    except Exception as exc:
        await session.rollback()
        _translate(exc)
    return _encounter_out(view)


@router.post("/encounters/{encounter_id}/refresh", response_model=EncounterRefreshOut)
async def refresh_encounter(
    encounter_id: uuid.UUID,
    payload: RevisionRequest,
    user: TtrpgUser,
    session: DbSession,
    storage: Storage,
) -> EncounterRefreshOut:
    """Explicitly pull the current creature cards into this encounter's slots.

    Fields the DM overrode and slot names are kept; a slot whose card is gone or archived is
    reported and left as it was.
    """
    service = EncounterService(session, user.id, storage)
    try:
        _, report = await service.refresh(encounter_id, base_revision=payload.base_revision)
        await session.commit()
        view = await service.view(encounter_id)
    except Exception as exc:
        await session.rollback()
        _translate(exc)
    return EncounterRefreshOut(
        encounter=_encounter_out(view),
        slots=[SlotRefreshOut(slot_id=r.slot_id, name=r.name, outcome=r.outcome) for r in report],
    )


@router.post("/encounters/{encounter_id}/link-to-note", response_model=NoteLinkResultOut)
async def link_encounter_into_note(
    encounter_id: uuid.UUID, user: TtrpgUser, session: DbSession, storage: Storage
) -> NoteLinkResultOut:
    """Add this encounter's launch link under "Prep" in its session's note (idempotent)."""
    service = EncounterService(session, user.id, storage)
    try:
        link, changed = await service.link_into_session_note(encounter_id)
        await session.commit()
    except Exception as exc:
        await session.rollback()
        _translate(exc)
    return NoteLinkResultOut(link=link, changed=changed)


# --- combat runs (TTRPG-06) ----------------------------------------------------------


class RunResourceOut(BaseModel):
    key: str
    name: str
    max: int
    used: int


class RunActionLineOut(BaseModel):
    name: str
    kind: str
    to_hit: int | None
    damage: str


class CombatantOut(BaseModel):
    model_config = ConfigDict(json_schema_serialization_defaults_required=True)

    id: uuid.UUID
    kind: Literal["npc", "party"]
    side: Literal["enemy", "ally", "party"]
    party_member_id: uuid.UUID | None
    name: str
    ac: int
    hp: int
    max_hp: int
    temp_hp: int
    conditions: list[str]
    #: ``{condition: round}``: remind the DM at that round; nothing is removed automatically
    condition_reminders: dict[str, int]
    initiative_mod: int
    initiative: int | None
    order_index: int | None
    defeated: bool
    removed: bool
    active: bool
    #: party only: the revision of the play state to send back with a change
    party_revision: int | None
    death_save_successes: int
    death_save_failures: int
    resources: list[RunResourceOut]
    attacks: list[RunActionLineOut]


class RunActionOut(BaseModel):
    seq: int
    kind: str
    summary: str
    combatant_id: uuid.UUID | None
    reversible: bool
    undone: bool
    created_at: datetime


class ReminderDueOut(BaseModel):
    combatant_id: uuid.UUID
    condition: str
    round: int


class RunOut(BaseModel):
    model_config = ConfigDict(json_schema_serialization_defaults_required=True)

    id: uuid.UUID
    campaign_id: uuid.UUID
    session_id: uuid.UUID | None
    encounter_id: uuid.UUID | None
    title: str
    status: Literal["setup", "active", "paused", "ended"]
    round: int
    active_combatant_id: uuid.UUID | None
    revision: int
    outcome: str | None
    end_reason: str | None
    started_at: datetime | None
    ended_at: datetime | None
    book_reference: str | None
    setup_reminder: str | None
    combatants: list[CombatantOut]
    #: setup only: groups of combatants with the same initiative total, to order by hand
    ties: list[list[uuid.UUID]]
    undo_summary: str | None
    history: list[RunActionOut]
    reminders_due: list[ReminderDueOut]
    conditions: list[str]


class RunSummaryOut(BaseModel):
    id: uuid.UUID
    title: str
    status: Literal["setup", "active", "paused", "ended"]
    round: int
    revision: int
    outcome: str | None
    started_at: datetime | None
    ended_at: datetime | None


class RunListOut(BaseModel):
    items: list[RunSummaryOut]


class RunCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: uuid.UUID | None = None
    encounter_id: uuid.UUID | None = None
    session_id: uuid.UUID | None = None
    title: str | None = Field(default=None, max_length=200)
    party_member_ids: list[uuid.UUID] | None = Field(default=None, max_length=12)


class RunSetup(BaseModel):
    model_config = ConfigDict(extra="forbid")

    base_revision: int = Field(ge=1)
    initiative: dict[uuid.UUID, int | None] | None = None
    add: list[NewCombatant] | None = Field(default=None, max_length=60)
    set_removed: dict[uuid.UUID, bool] | None = None


class RunStart(BaseModel):
    model_config = ConfigDict(extra="forbid")

    base_revision: int = Field(ge=1)
    #: combatants with equal totals, in the order they should act
    tie_order: list[uuid.UUID] | None = Field(default=None, max_length=100)


class RunActionRequest(ActionRequest):
    #: a unique key per intended change: a retry with the same key never applies twice
    mutation_key: str = Field(min_length=8, max_length=64)
    base_revision: int = Field(ge=1)


class RunUndoRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mutation_key: str = Field(min_length=8, max_length=64)
    base_revision: int = Field(ge=1)


class RunActionResultOut(BaseModel):
    run: RunOut
    action: RunActionOut | None
    #: True when this mutation key had already been applied: nothing was applied again
    replayed: bool


class RunHistoryOut(BaseModel):
    items: list[RunActionOut]


def _combatant_out(view: CombatantView, active_id: uuid.UUID | None) -> CombatantOut:
    row, member, state = view.row, view.member, view.state
    resources: list[RunResourceOut] = []
    if member is not None and state is not None:
        resources = [
            RunResourceOut(
                key=item["key"],
                name=item["name"],
                max=item["max"],
                used=state.resources_used.get(item["key"], 0),
            )
            for item in member.resources
        ]
    source = (
        [
            RunActionLineOut(
                name=item["name"],
                kind=item.get("kind", "action"),
                to_hit=item.get("to_hit"),
                damage=item.get("damage", ""),
            )
            for item in row.snapshot.get("actions", [])
        ]
        if member is None
        else [
            RunActionLineOut(
                name=item["name"],
                kind="action",
                to_hit=item.get("to_hit"),
                damage=item.get("damage", ""),
            )
            for item in member.attacks
        ]
    )
    return CombatantOut(
        id=row.id,
        kind=row.kind,
        side=row.side,
        party_member_id=row.party_member_id,
        name=row.name,
        ac=member.ac if member is not None else row.ac,
        hp=view.hp,
        max_hp=member.max_hp if member is not None else row.max_hp,
        temp_hp=view.temp_hp,
        conditions=view.conditions,
        condition_reminders=dict(row.condition_reminders),
        initiative_mod=row.initiative_mod,
        initiative=row.initiative,
        order_index=row.order_index,
        defeated=row.defeated,
        removed=row.removed,
        active=row.id == active_id,
        party_revision=state.revision if state is not None else None,
        death_save_successes=state.death_save_successes if state is not None else 0,
        death_save_failures=state.death_save_failures if state is not None else 0,
        resources=resources,
        attacks=source,
    )


def _run_action_out(action: TtrpgCombatAction) -> RunActionOut:
    return RunActionOut(
        seq=action.seq,
        kind=action.kind,
        summary=action.summary,
        combatant_id=action.combatant_id,
        reversible=action.reversible,
        undone=action.undone_by_seq is not None,
        created_at=action.created_at,
    )


def _run_out(view: RunView) -> RunOut:
    run = view.run
    snapshot = run.encounter_snapshot or {}
    return RunOut(
        id=run.id,
        campaign_id=run.campaign_id,
        session_id=run.session_id,
        encounter_id=run.encounter_id,
        title=run.title,
        status=run.status,
        round=run.round,
        active_combatant_id=run.active_combatant_id,
        revision=run.revision,
        outcome=run.outcome,
        end_reason=run.end_reason,
        started_at=run.started_at,
        ended_at=run.ended_at,
        book_reference=snapshot.get("book_reference"),
        setup_reminder=snapshot.get("setup_reminder"),
        combatants=[_combatant_out(c, run.active_combatant_id) for c in view.combatants],
        ties=view.ties,
        undo_summary=view.undo.summary if view.undo else None,
        history=[_run_action_out(a) for a in view.history],
        reminders_due=[
            ReminderDueOut(combatant_id=cid, condition=name, round=rnd)
            for cid, name, rnd in view.reminders_due
        ],
        conditions=list(rules.CONDITIONS),
    )


@router.get("/campaigns/{campaign_id}/runs", response_model=RunListOut)
async def list_runs(
    campaign_id: uuid.UUID, user: TtrpgUser, session: DbSession, unfinished: bool = False
) -> RunListOut:
    """The campaign's fights, newest first; ``unfinished`` lists only one that can be resumed."""
    try:
        runs = await RunService(session, user.id).list_runs(campaign_id, unfinished_only=unfinished)
    except Exception as exc:
        _translate(exc)
    return RunListOut(
        items=[
            RunSummaryOut(
                id=r.id,
                title=r.title,
                status=r.status,
                round=r.round,
                revision=r.revision,
                outcome=r.outcome,
                started_at=r.started_at,
                ended_at=r.ended_at,
            )
            for r in runs
        ]
    )


@router.post(
    "/campaigns/{campaign_id}/runs", response_model=RunOut, status_code=status.HTTP_201_CREATED
)
async def create_run(
    campaign_id: uuid.UUID,
    payload: RunCreate,
    response: Response,
    user: TtrpgUser,
    session: DbSession,
) -> RunOut:
    """Launch a prepared encounter (or improvise one) into initiative setup.

    Enemies start fresh from the encounter's copied stats; the party's hit points, conditions and
    resources are read from the party's existing play state. A campaign has at most one unfinished
    fight (409 with its id). A retry with the same ``id`` returns the same run (``200``).
    """
    service = RunService(session, user.id)
    try:
        run, created = await service.create_run(
            campaign_id,
            run_id=payload.id,
            encounter_id=payload.encounter_id,
            session_id=payload.session_id,
            title=payload.title,
            party_member_ids=payload.party_member_ids,
        )
        await session.commit()
        view = await service.view(run.id)
    except Exception as exc:
        await session.rollback()
        _translate(exc)
    if not created:
        response.status_code = status.HTTP_200_OK
    return _run_out(view)


@router.get("/runs/{run_id}", response_model=RunOut)
async def get_run(run_id: uuid.UUID, user: TtrpgUser, session: DbSession) -> RunOut:
    """The whole fight as stored: reload recovers the same round, actor, initiative, HP and
    conditions."""
    try:
        return _run_out(await RunService(session, user.id).view(run_id))
    except Exception as exc:
        _translate(exc)


@router.patch("/runs/{run_id}/setup", response_model=RunOut)
async def setup_run(
    run_id: uuid.UUID, payload: RunSetup, user: TtrpgUser, session: DbSession
) -> RunOut:
    """Before the start: enter initiative totals (zero and negative are fine), add or remove
    combatants."""
    service = RunService(session, user.id)
    try:
        await service.setup(
            run_id,
            base_revision=payload.base_revision,
            initiative=payload.initiative,
            add=payload.add,
            set_removed=payload.set_removed,
        )
        await session.commit()
        return _run_out(await service.view(run_id))
    except Exception as exc:
        await session.rollback()
        _translate(exc)


@router.post("/runs/{run_id}/start", response_model=RunOut)
async def start_run(
    run_id: uuid.UUID, payload: RunStart, user: TtrpgUser, session: DbSession
) -> RunOut:
    """Sort by initiative (ties in the given order) and begin round one."""
    service = RunService(session, user.id)
    try:
        await service.start(
            run_id, base_revision=payload.base_revision, tie_order=payload.tie_order
        )
        await session.commit()
        return _run_out(await service.view(run_id))
    except Exception as exc:
        await session.rollback()
        _translate(exc)


@router.post("/runs/{run_id}/actions", response_model=RunActionResultOut)
async def run_action(
    run_id: uuid.UUID, payload: RunActionRequest, user: TtrpgUser, session: DbSession
) -> RunActionResultOut:
    """Apply one change to a running fight.

    Send the run ``base_revision`` you saw, a unique ``mutation_key`` and, for a change to a party
    member, that member's current ``party_revisions``. A stale revision is a 409 and nothing
    changes; a retry with the same key is a replay and applies nothing twice.
    """
    service = RunService(session, user.id)
    request = ActionRequest(
        **payload.model_dump(exclude={"mutation_key", "base_revision"}, exclude_unset=True)
    )
    try:
        result = await service.apply(
            run_id,
            mutation_key=payload.mutation_key,
            base_revision=payload.base_revision,
            request=request,
        )
        await session.commit()
    except Exception as exc:
        await session.rollback()
        _translate(exc)
    return RunActionResultOut(
        run=_run_out(result.view),
        action=_run_action_out(result.action) if result.action else None,
        replayed=result.replayed,
    )


@router.post("/runs/{run_id}/undo", response_model=RunActionResultOut)
async def undo_run_action(
    run_id: uuid.UUID, payload: RunUndoRequest, user: TtrpgUser, session: DbSession
) -> RunActionResultOut:
    """Undo the most recent reversible action, party effects included, in one transaction.

    If anything else changed the affected state since (another edit of the party member, say) the
    answer is ``409 undo_conflict`` and the newer state is kept.
    """
    service = RunService(session, user.id)
    try:
        result = await service.undo(
            run_id, mutation_key=payload.mutation_key, base_revision=payload.base_revision
        )
        await session.commit()
    except Exception as exc:
        await session.rollback()
        _translate(exc)
    return RunActionResultOut(
        run=_run_out(result.view),
        action=_run_action_out(result.action) if result.action else None,
        replayed=result.replayed,
    )


@router.get("/runs/{run_id}/actions", response_model=RunHistoryOut)
async def run_history(
    run_id: uuid.UUID,
    user: TtrpgUser,
    session: DbSession,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    before_seq: Annotated[int | None, Query(ge=1)] = None,
) -> RunHistoryOut:
    """The history, newest first (page with ``before_seq``). Readable after the fight ends."""
    try:
        rows = await RunService(session, user.id).actions(
            run_id, limit=limit, before_seq=before_seq
        )
    except Exception as exc:
        _translate(exc)
    return RunHistoryOut(items=[_run_action_out(a) for a in rows])
