# Copyright (c) 2026 OpenNVR
# Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0)
"""Live View tours: camera sets a display board cycles through.

A tour is ordered steps — a layout, a list of cameras and how long to show
them. A step may hold more cameras than its layout has tiles; the player
pages through them. Running a tour needs ``live.view``; changing one needs
``cameras.manage`` (the camera-zones rule) and the right to manage every
camera still in it.

Every read is filtered to the caller: a step only ever lists cameras the
caller may see and that are not in the bin, plus a count of the rest, so a
tour never leaks a camera and survives a camera being deleted. A layout the
tour names may later be deleted or disabled in Window Settings; the read
says so (``layout_missing``) and the player falls back to an automatic grid.
A step may also name a plain grid, ``grid:<cols>x<rows>`` (1..8 each),
which needs no Window Settings entry.
"""

from __future__ import annotations

import logging
import re
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func
from sqlalchemy.orm import Session

from core.database import get_db, release
from core.permissions import RequirePermission
from models import Camera, CameraTour, User
from schemas import WindowDivisionSettings
from services import camera_thumbnail as camera_thumbnail_service
from services.audit_service import audit_request
from services.camera_scope import can_view_camera, manageable_camera_ids, visible_camera_ids

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/tours", tags=["tours"])

_view = RequirePermission("live.view")
_manage = RequirePermission("cameras.manage")

MAX_STEPS = 100
MAX_CAMERAS_PER_STEP = 256
# A plain C×R grid needs no Window Settings entry: "grid:5x4" is the
# 20-camera wall without first building a 20-tile custom layout by hand.
_GRID_RE = re.compile(r"^grid:([1-8])x([1-8])$")


def _trim(ids: list[int | None]) -> list[int | None]:
    """Without the empty tiles at the end: they are simply where the step stops."""
    end = len(ids)
    while end and ids[end - 1] is None:
        end -= 1
    return ids[:end]


class TourStepIn(BaseModel):
    label: str = Field("", max_length=60)
    layout_id: str = Field(..., min_length=1, max_length=50)
    duration_s: int = Field(60, ge=10, le=3600)
    #: In tile order across the step's pages; ``null`` is a tile left empty,
    #: so taking a camera out of a wall moves no other camera.
    camera_ids: list[int | None] = Field(..., min_length=1, max_length=MAX_CAMERAS_PER_STEP)

    @field_validator("label")
    @classmethod
    def _label(cls, v: str) -> str:
        return v.strip()

    @field_validator("camera_ids")
    @classmethod
    def _dedupe(cls, v: list[int | None]) -> list[int | None]:
        # Keep the admin's order and every camera's tile; a camera twice in
        # one step is a slip, and its second tile is left empty.
        seen: set[int] = set()
        out: list[int | None] = []
        for c in v:
            out.append(None if c is None or c in seen else c)
            if c is not None:
                seen.add(c)
        out = _trim(out)
        if not out:
            raise ValueError("a step needs at least one camera")
        return out


class TourAlerts(BaseModel):
    """Alarm takeover: an alert on a camera brings it to the front of the
    wall for ``hold_s``, then the tour carries on where it was."""

    enabled: bool = False
    #: app_alert = alerts from apps and camera analytics (alerts inbox);
    #: camera_event = the camera's own alarms (motion, tamper, line crossing).
    sources: list[Literal["app_alert", "camera_event"]] = Field(
        default_factory=lambda: ["app_alert", "camera_event"], min_length=1)
    #: App alerts below this severity are ignored (alerts_inbox._SEVERITIES).
    min_severity: Literal["low", "medium", "high", "critical"] = "medium"
    #: "tour" = only cameras in this tour; "visible" = any camera the viewer sees.
    scope: Literal["tour", "visible"] = "tour"
    hold_s: int = Field(30, ge=5, le=600)
    #: A camera that just took over cannot take over again for this long.
    cooldown_s: int = Field(60, ge=0, le=3600)

    @field_validator("sources")
    @classmethod
    def _dedupe_sources(cls, v: list[str]) -> list[str]:
        return list(dict.fromkeys(v))


class TourSettings(BaseModel):
    #: "fit" letterboxes each camera; "fill" crops it to fill its tile.
    fit: Literal["fit", "fill"] = "fit"
    #: How one page gives way to the next: a straight cut or a short crossfade.
    transition: Literal["cut", "fade"] = "fade"
    #: Play the next page's cameras, hidden, for the last seconds of a page,
    #: so they are already playing when it shows.
    preload: bool = True
    alerts: TourAlerts = Field(default_factory=TourAlerts)


def _settings_of(tour: CameraTour) -> dict:
    """The tour's settings over the defaults; a stored value that no longer
    validates falls back to the defaults rather than failing the read."""
    try:
        return TourSettings(**(tour.settings or {})).model_dump()
    except Exception:
        logger.warning("tour %s has unreadable settings; using defaults", tour.id)
        return TourSettings().model_dump()


class TourIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    description: str | None = Field(None, max_length=500)
    enabled: bool = True
    steps: list[TourStepIn] = Field(..., min_length=1, max_length=MAX_STEPS)
    #: None on an update keeps what the tour has; on create, the defaults.
    settings: TourSettings | None = None
    #: On update: the revision the editor loaded. A mismatch is a 409.
    expected_revision: int | None = None

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("name is empty")
        return v


class TourEnabledIn(BaseModel):
    enabled: bool
    expected_revision: int | None = None


def _usable_layout_ids(db: Session) -> set[str]:
    """Layout ids Live View would offer right now: enabled predefined ones
    and enabled custom ones. A broken window-settings row must never break
    tours, so on any error only the predefined layouts count."""
    defaults = WindowDivisionSettings()
    try:
        from routers.window_settings import _load

        ws = _load(db)
    except Exception:
        logger.warning("window settings unreadable; tours use predefined layouts only",
                       exc_info=True)
        return set(defaults.layouts_enabled)
    ids = {k for k in defaults.layouts_enabled if ws.layouts_enabled.get(k, True)}
    ids |= {c.id for c in ws.custom_layouts if c.enabled}
    return ids


def _layout_ok(layout_id: str | None, layouts: set[str]) -> bool:
    return bool(layout_id) and (layout_id in layouts or bool(_GRID_RE.fullmatch(layout_id)))


class _Scope:
    """What every tour read and write needs, loaded once per request: the
    usable layouts, every camera not in the bin (``{id: is_active}``, one
    query whatever the tours hold) and the caller's two camera scopes
    (``None`` = unrestricted)."""

    def __init__(self, db: Session, user: User):
        self.layouts = _usable_layout_ids(db)
        self.live = {cid: bool(active) for cid, active in
                     db.query(Camera.id, Camera.is_active)
                     .filter(Camera.deleted_at.is_(None)).all()}
        self.visible = visible_camera_ids(db, user)
        self.manageable = manageable_camera_ids(db, user)

    def editable(self, tour: CameraTour) -> bool:
        """May this caller change or delete the tour? Only when they may
        manage every camera still in it: a save carrying one they cannot
        manage is refused, and one they cannot see would be dropped."""
        if self.manageable is None:
            return True
        return all(int(c) in self.manageable
                   for s in (tour.steps or []) for c in (s.get("camera_ids") or [])
                   if c is not None and int(c) in self.live)


def _serialize(tour: CameraTour, scope: _Scope) -> dict:
    out_steps = []
    for s in tour.steps or []:
        ids = [None if c is None else int(c) for c in (s.get("camera_ids") or [])]
        # A camera in the bin, or one this viewer may not see, leaves its
        # tile empty rather than pulling the later cameras forward.
        slots = [c if c is not None and c in scope.live
                 and (scope.visible is None or c in scope.visible) else None for c in ids]
        shown = [c for c in slots if c is not None]
        out_steps.append({
            "label": s.get("label") or "",
            "layout_id": s.get("layout_id"),
            "duration_s": int(s.get("duration_s") or 60),
            "camera_ids": _trim(slots),
            "paused_camera_ids": [c for c in shown if not scope.live[c]],
            "hidden_count": sum(c is not None for c in ids) - len(shown),
            "layout_missing": not _layout_ok(s.get("layout_id"), scope.layouts),
        })
    return {
        "id": tour.id,
        "name": tour.name,
        "description": tour.description,
        "enabled": bool(tour.enabled),
        "revision": tour.revision or 1,
        "settings": _settings_of(tour),
        "editable": scope.editable(tour),
        "steps": out_steps,
        "created_at": tour.created_at.isoformat() if tour.created_at else None,
        "updated_at": tour.updated_at.isoformat() if tour.updated_at else None,
    }


def _validate(payload: TourIn, scope: _Scope) -> list[dict]:
    """The steps as stored, or a 422 naming exactly what is wrong."""
    bad_layouts = sorted({s.layout_id for s in payload.steps
                          if not _layout_ok(s.layout_id, scope.layouts)})
    if bad_layouts:
        raise HTTPException(status_code=422, detail={
            "message": "Unknown or disabled layout", "layout_ids": bad_layouts})
    wanted = {c for s in payload.steps for c in s.camera_ids if c is not None}
    bad = sorted(c for c in wanted if c not in scope.live
                 or (scope.manageable is not None and c not in scope.manageable))
    if bad:
        raise HTTPException(status_code=422, detail={
            "message": "Unknown cameras, or cameras you cannot manage", "camera_ids": bad})
    return [s.model_dump() for s in payload.steps]


def _tour_or_404(db: Session, tour_id: int) -> CameraTour:
    tour = db.query(CameraTour).filter(CameraTour.id == tour_id).first()
    if tour is None:
        raise HTTPException(status_code=404, detail="Tour not found")
    return tour


def _editable_or_403(tour: CameraTour, scope: _Scope) -> None:
    if not scope.editable(tour):
        raise HTTPException(status_code=403,
                            detail="This tour includes cameras you cannot manage")


def _save(db: Session, tour_id: int, expected: int | None, values: dict) -> None:
    """Write *values* and bump the revision in ONE conditional UPDATE, so of
    two saves made from the same revision exactly one lands and the other is
    a 409 (a read-then-write check would let both through)."""
    q = db.query(CameraTour).filter(CameraTour.id == tour_id)
    if expected is not None:
        q = q.filter(CameraTour.revision == expected)
    n = q.update({**values, CameraTour.revision: CameraTour.revision + 1,
                  CameraTour.updated_at: func.now()}, synchronize_session=False)
    if n == 0:
        db.rollback()
        raise HTTPException(status_code=409, detail="The tour was changed by someone else")
    db.commit()


@router.get("")
async def list_tours(
    db: Session = Depends(get_db),
    current_user: User = Depends(_view),
):
    scope = _Scope(db, current_user)
    rows = db.query(CameraTour).order_by(CameraTour.name, CameraTour.id).all()
    return {"tours": [_serialize(t, scope) for t in rows]}


@router.get("/thumbnails/{camera_id}")
async def camera_thumbnail(
    camera_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(_view),
):
    """A small, cached JPEG still of a camera for the tour editor's picker
    (services/camera_thumbnail.py). 404 for a camera the caller may not see
    or that is in the bin; 503 when no frame can be had (offline, paused)."""
    cam = db.query(Camera).filter(Camera.id == camera_id, Camera.deleted_at.is_(None)).first()
    if cam is None or not can_view_camera(db, current_user, camera_id):
        raise HTTPException(status_code=404, detail="Camera not found")
    if not cam.is_active or not cam.rtsp_url:
        raise HTTPException(status_code=503, detail="Camera is not streaming")
    cam_id, rtsp_url = cam.id, cam.rtsp_url
    # The grab can take seconds; never hold a pooled connection across it.
    release(db)
    jpeg = await camera_thumbnail_service.get_thumbnail(cam_id, rtsp_url)
    if not jpeg:
        raise HTTPException(status_code=503, detail="No picture from this camera right now")
    return Response(content=jpeg, media_type="image/jpeg",
                    headers={"Cache-Control": "private, max-age=300"})


@router.get("/{tour_id}")
async def get_tour(
    tour_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(_view),
):
    return _serialize(_tour_or_404(db, tour_id), _Scope(db, current_user))


@router.post("", status_code=201)
async def create_tour(
    payload: TourIn,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(_manage),
):
    scope = _Scope(db, current_user)
    steps = _validate(payload, scope)
    tour = CameraTour(name=payload.name, description=payload.description,
                      enabled=payload.enabled, steps=steps, revision=1,
                      settings=(payload.settings or TourSettings()).model_dump(),
                      created_by=getattr(current_user, "id", None))
    db.add(tour)
    db.commit()
    db.refresh(tour)
    audit_request(db, request, action="tour.create", user_id=current_user.id,
                  entity_type="camera_tour", entity_id=tour.id,
                  details={"name": tour.name, "steps": len(steps)})
    return _serialize(tour, scope)


@router.put("/{tour_id}")
async def update_tour(
    tour_id: int,
    payload: TourIn,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(_manage),
):
    tour = _tour_or_404(db, tour_id)
    scope = _Scope(db, current_user)
    _editable_or_403(tour, scope)
    steps = _validate(payload, scope)
    values = {CameraTour.name: payload.name, CameraTour.description: payload.description,
              CameraTour.enabled: payload.enabled, CameraTour.steps: steps}
    if payload.settings is not None:
        values[CameraTour.settings] = payload.settings.model_dump()
    _save(db, tour_id, payload.expected_revision, values)
    db.refresh(tour)
    audit_request(db, request, action="tour.update", user_id=current_user.id,
                  entity_type="camera_tour", entity_id=tour.id,
                  details={"name": tour.name, "steps": len(steps)})
    return _serialize(tour, scope)


@router.patch("/{tour_id}")
async def set_tour_enabled(
    tour_id: int,
    payload: TourEnabledIn,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(_manage),
):
    """Turn a tour on or off and nothing else. Its steps are not re-sent, so
    a tour whose layout was since deleted, or whose cameras are all in the
    bin, can still be switched, and nothing in it is rewritten."""
    tour = _tour_or_404(db, tour_id)
    scope = _Scope(db, current_user)
    _editable_or_403(tour, scope)
    _save(db, tour_id, payload.expected_revision, {CameraTour.enabled: payload.enabled})
    db.refresh(tour)
    audit_request(db, request, action="tour.update", user_id=current_user.id,
                  entity_type="camera_tour", entity_id=tour.id,
                  details={"name": tour.name, "enabled": payload.enabled})
    return _serialize(tour, scope)


@router.delete("/{tour_id}")
async def delete_tour(
    tour_id: int,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(_manage),
):
    tour = _tour_or_404(db, tour_id)
    _editable_or_403(tour, _Scope(db, current_user))
    name = tour.name
    db.delete(tour)
    db.commit()
    audit_request(db, request, action="tour.delete", user_id=current_user.id,
                  entity_type="camera_tour", entity_id=tour_id,
                  details={"name": name})
    return {"deleted": tour_id}
