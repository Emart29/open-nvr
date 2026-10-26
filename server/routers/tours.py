# Copyright (c) 2026 OpenNVR
# Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0)
"""Live View tours: camera sets a display board cycles through.

A tour is ordered steps — a layout, a list of cameras and how long to show
them. A step may hold more cameras than its layout has tiles; the player
pages through them. Running a tour needs ``live.view``; changing one needs
``cameras.manage`` (the camera-zones rule).

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

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.orm import Session

from core.database import get_db
from core.permissions import RequirePermission
from models import Camera, CameraTour, User
from schemas import WindowDivisionSettings
from services.audit_service import audit_request
from services.camera_scope import manageable_camera_ids, visible_camera_ids

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/tours", tags=["tours"])

_view = RequirePermission("live.view")
_manage = RequirePermission("cameras.manage")

MAX_STEPS = 100
MAX_CAMERAS_PER_STEP = 256
# A plain C×R grid needs no Window Settings entry: "grid:5x4" is the
# 20-camera wall without first building a 20-tile custom layout by hand.
_GRID_RE = re.compile(r"^grid:([1-8])x([1-8])$")


class TourStepIn(BaseModel):
    label: str = Field("", max_length=60)
    layout_id: str = Field(..., min_length=1, max_length=50)
    duration_s: int = Field(60, ge=10, le=3600)
    camera_ids: list[int] = Field(..., min_length=1, max_length=MAX_CAMERAS_PER_STEP)

    @field_validator("label")
    @classmethod
    def _label(cls, v: str) -> str:
        return v.strip()

    @field_validator("camera_ids")
    @classmethod
    def _dedupe(cls, v: list[int]) -> list[int]:
        # Keep the admin's order; a camera twice in one step is a slip.
        return list(dict.fromkeys(v))


class TourIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    description: str | None = Field(None, max_length=500)
    enabled: bool = True
    steps: list[TourStepIn] = Field(..., min_length=1, max_length=MAX_STEPS)
    #: On update: the revision the editor loaded. A mismatch is a 409.
    expected_revision: int | None = None

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("name is empty")
        return v


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


def _live_camera_ids(db: Session, ids: set[int]) -> dict[int, bool]:
    """``{id: is_active}`` for the cameras among *ids* that are not binned."""
    if not ids:
        return {}
    rows = (db.query(Camera.id, Camera.is_active)
            .filter(Camera.id.in_(sorted(ids)), Camera.deleted_at.is_(None)).all())
    return {cid: bool(active) for cid, active in rows}


def _serialize(db: Session, tour: CameraTour, user: User,
               layouts: set[str] | None = None) -> dict:
    layouts = _usable_layout_ids(db) if layouts is None else layouts
    steps = tour.steps or []
    wanted = {int(c) for s in steps for c in (s.get("camera_ids") or [])}
    live = _live_camera_ids(db, wanted)
    scope = visible_camera_ids(db, user)
    out_steps = []
    editable = True
    for s in steps:
        ids = [int(c) for c in (s.get("camera_ids") or [])]
        shown = [c for c in ids if c in live and (scope is None or c in scope)]
        # A camera hidden from the caller (not one that was deleted) makes
        # the tour read-only for them: saving would drop it silently.
        if any(c in live and scope is not None and c not in scope for c in ids):
            editable = False
        out_steps.append({
            "label": s.get("label") or "",
            "layout_id": s.get("layout_id"),
            "duration_s": int(s.get("duration_s") or 60),
            "camera_ids": shown,
            "paused_camera_ids": [c for c in shown if not live[c]],
            "hidden_count": len(ids) - len(shown),
            "layout_missing": not _layout_ok(s.get("layout_id"), layouts),
        })
    return {
        "id": tour.id,
        "name": tour.name,
        "description": tour.description,
        "enabled": bool(tour.enabled),
        "revision": tour.revision or 1,
        "editable": editable,
        "steps": out_steps,
        "created_at": tour.created_at.isoformat() if tour.created_at else None,
        "updated_at": tour.updated_at.isoformat() if tour.updated_at else None,
    }


def _validate(db: Session, payload: TourIn, user: User) -> list[dict]:
    """The steps as stored, or a 422 naming exactly what is wrong."""
    layouts = _usable_layout_ids(db)
    bad_layouts = sorted({s.layout_id for s in payload.steps if not _layout_ok(s.layout_id, layouts)})
    if bad_layouts:
        raise HTTPException(status_code=422, detail={
            "message": "Unknown or disabled layout", "layout_ids": bad_layouts})
    wanted = {c for s in payload.steps for c in s.camera_ids}
    live = _live_camera_ids(db, wanted)
    scope = manageable_camera_ids(db, user)
    bad = sorted(c for c in wanted if c not in live or (scope is not None and c not in scope))
    if bad:
        raise HTTPException(status_code=422, detail={
            "message": "Unknown cameras, or cameras you cannot manage", "camera_ids": bad})
    return [s.model_dump() for s in payload.steps]


def _tour_or_404(db: Session, tour_id: int) -> CameraTour:
    tour = db.query(CameraTour).filter(CameraTour.id == tour_id).first()
    if tour is None:
        raise HTTPException(status_code=404, detail="Tour not found")
    return tour


@router.get("")
async def list_tours(
    db: Session = Depends(get_db),
    current_user: User = Depends(_view),
):
    layouts = _usable_layout_ids(db)
    rows = db.query(CameraTour).order_by(CameraTour.name, CameraTour.id).all()
    return {"tours": [_serialize(db, t, current_user, layouts) for t in rows]}


@router.get("/{tour_id}")
async def get_tour(
    tour_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(_view),
):
    return _serialize(db, _tour_or_404(db, tour_id), current_user)


@router.post("", status_code=201)
async def create_tour(
    payload: TourIn,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(_manage),
):
    steps = _validate(db, payload, current_user)
    tour = CameraTour(name=payload.name, description=payload.description,
                      enabled=payload.enabled, steps=steps, revision=1,
                      created_by=getattr(current_user, "id", None))
    db.add(tour)
    db.commit()
    db.refresh(tour)
    audit_request(db, request, action="tour.create", user_id=current_user.id,
                  entity_type="camera_tour", entity_id=tour.id,
                  details={"name": tour.name, "steps": len(steps)})
    return _serialize(db, tour, current_user)


@router.put("/{tour_id}")
async def update_tour(
    tour_id: int,
    payload: TourIn,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(_manage),
):
    tour = _tour_or_404(db, tour_id)
    if payload.expected_revision is not None and payload.expected_revision != (tour.revision or 1):
        raise HTTPException(status_code=409, detail="The tour was changed by someone else")
    if not _serialize(db, tour, current_user)["editable"]:
        raise HTTPException(status_code=403,
                            detail="This tour includes cameras you cannot access")
    steps = _validate(db, payload, current_user)
    tour.name, tour.description, tour.enabled = payload.name, payload.description, payload.enabled
    tour.steps = steps
    tour.revision = (tour.revision or 1) + 1
    db.commit()
    db.refresh(tour)
    audit_request(db, request, action="tour.update", user_id=current_user.id,
                  entity_type="camera_tour", entity_id=tour.id,
                  details={"name": tour.name, "steps": len(steps)})
    return _serialize(db, tour, current_user)


@router.delete("/{tour_id}")
async def delete_tour(
    tour_id: int,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(_manage),
):
    tour = _tour_or_404(db, tour_id)
    if not _serialize(db, tour, current_user)["editable"]:
        raise HTTPException(status_code=403,
                            detail="This tour includes cameras you cannot access")
    name = tour.name
    db.delete(tour)
    db.commit()
    audit_request(db, request, action="tour.delete", user_id=current_user.id,
                  entity_type="camera_tour", entity_id=tour_id,
                  details={"name": name})
    return {"deleted": tour_id}
