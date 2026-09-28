# Copyright (c) 2026 OpenNVR
# Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0)
"""Describe what a question needs, now — the requested lane (#583).

A search for "blue car on the gate camera between two and four" can be
answered only from visits somebody has already described. On a box
where enrichment is off (a CPU install — the installer's default), or
throttled, or simply behind, most of those visits have no caption and
no colour claim yet. Search answers from what exists and says so; this
module is the "and I'm describing the rest now" that goes with it.

Three parts:

* :func:`missing_for` — of the visits the question's STRUCTURAL filters
  match (label, camera, window, plate, zone), which lack the parameter
  the question needs: a caption when there are words to match, a claim
  of the kind an attribute asks for. Newest first, capped.
* :func:`request` — queue those for enrichment, deduplicated against
  what is already queued or in flight, and return a ticket the caller
  can put in its answer: how many, and roughly how long.
* :func:`run_requests_worker` — one worker, started at boot, that hands
  each visit to the SAME enrichers the ingest path calls, with the
  ``requested`` priority: the governor lets it through in LIVE-ONLY
  with a full wait line (somebody is waiting on this, unlike a live
  visit the catch-up will reach) and still refuses it PAUSED (the box
  is losing; a question does not change that). Each finished request
  is announced on the bus so the agent or the UI can ask again.

Bounded on purpose: ``EVENTS_ENRICHMENT_REQUEST_CAP`` visits per
question. "Last month" on a busy site is thousands; the answer to that
is a narrower window, not a queue that runs until tomorrow.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import exists, or_

from models import EventText, TimelineEvent, VisitDescriptor

logger = logging.getLogger("enrichment_requests")

#: The bus event a finished request publishes.
DONE_ALERT_TYPE = "enrichment_request_done"

#: Per-call estimate when no adapter has answered yet this process.
DEFAULT_CALL_S = 5.0

#: How long the worker waits between re-checks while the governor says
#: PAUSED, and how many times a visit refused by the gate is retried.
_PAUSED_POLL_S = 5.0
_DROP_RETRIES = 3
_DROP_RETRY_S = 2.0


def request_cap() -> int:
    from core.config import settings

    return max(1, int(getattr(settings, "events_enrichment_request_cap", 50)))


# ── what is missing ───────────────────────────────────────────────

def missing_for(db, *, filters: dict[str, Any], labels: list[str] | None,
                camera_ids: list[int] | None, want_caption: bool,
                want_kinds: set[str], cap: int | None = None) -> dict[str, Any]:
    """Visits the structural filters match that lack what the question
    needs. ``filters`` are ``timeline_service._events_query`` keywords —
    the same predicate search pages with, so "missing" and "matched"
    are counted over the same rows.

    Returns ``{"ids": [...newest first, capped], "caption": n,
    "kinds": {kind: n}, "total": n}`` where the counts are UNCAPPED —
    the honest size of what is not described — and ``ids`` is what one
    request may take on.
    """
    from services.caption_enrichment import CAPTIONABLE_LABELS
    from services.descriptor_enrichment import DESCRIBABLE_LABELS
    from services.timeline_service import _events_query

    cap = cap or request_cap()
    out: dict[str, Any] = {"ids": [], "caption": 0, "kinds": {}, "total": 0}
    if not (want_caption or want_kinds):
        return out

    base = _events_query(db, **filters).filter(TimelineEvent.evidence_path.isnot(None))
    if labels:
        base = base.filter(TimelineEvent.label.in_([str(x).lower() for x in labels]))
    if camera_ids:
        base = base.filter(TimelineEvent.camera_id.in_([int(c) for c in camera_ids]))

    ids: list[int] = []
    seen: set[int] = set()

    def take(q) -> int:
        n = q.count()
        for (eid,) in q.with_entities(TimelineEvent.id).order_by(
                TimelineEvent.id.desc()).limit(cap).all():
            if eid not in seen and len(ids) < cap:
                seen.add(eid); ids.append(int(eid))
        return int(n)

    if want_caption:
        q = (base.filter(TimelineEvent.label.in_(sorted(CAPTIONABLE_LABELS)))
             .outerjoin(EventText, EventText.event_id == TimelineEvent.id)
             .filter(or_(EventText.event_id.is_(None),
                         EventText.caption.is_(None), EventText.caption == "")))
        out["caption"] = take(q)
    for kind in sorted(want_kinds):
        has = exists().where(VisitDescriptor.event_id == TimelineEvent.id,
                             VisitDescriptor.kind == kind)
        q = base.filter(TimelineEvent.label.in_(sorted(DESCRIBABLE_LABELS))).filter(~has)
        out["kinds"][kind] = take(q)
    out["ids"] = ids
    out["total"] = max([out["caption"], *out["kinds"].values()] or [0])
    return out


# ── from a question to a ticket ───────────────────────────────────

async def box_offers() -> tuple[bool, set[str]]:
    """(a captioner is registered and healthy, the descriptor kinds a
    healthy VQA skill offers). Best-effort: an unreadable plan reads as
    "offers nothing", which queues nothing — never an error."""
    try:
        from services.enrichment_plan import compute_enrichment_plan

        plan = await compute_enrichment_plan(None)
    except Exception:                              # noqa: BLE001
        return False, set()
    captions, kinds = False, set()
    for s in (plan or {}).get("skills") or []:
        if not isinstance(s, dict) or not s.get("healthy"):
            continue
        if s.get("task") == "image_captioning":
            captions = True
        kinds.update(k for k in (s.get("descriptor_kinds") or []) if isinstance(k, str))
    kinds.discard("face_id")                       # stays with the app that owns it
    return captions, kinds


def kinds_for_attrs(attrs) -> set[str]:
    """The descriptor kinds a list of (kind, value) chips asks for. A
    bare value (kind None — "blue") is resolved through the enricher's
    own vocabulary, so it asks for exactly the kinds that could have
    said it."""
    from services.descriptor_enrichment import KIND_QUESTIONS, normalise_answer

    out: set[str] = set()
    for kind, value in attrs or []:
        if kind:
            out.add(str(kind))
            continue
        for k in KIND_QUESTIONS:
            if normalise_answer(k, str(value)):
                out.add(k)
    return out


async def pending_for(db, *, filters: dict[str, Any], labels, camera_ids,
                      want_caption: bool, want_kinds: set[str]) -> dict[str, Any] | None:
    """The block a search answer carries: what is not described yet, and
    what this call queued. None when the question needs nothing the box
    could produce — a plain label-and-time search says nothing here."""
    captions_ok, offered = await box_offers()
    want_caption = bool(want_caption and captions_ok)
    want_kinds = {k for k in want_kinds if k in offered}
    if not (want_caption or want_kinds):
        return None
    missing = missing_for(db, filters=filters, labels=labels, camera_ids=camera_ids,
                          want_caption=want_caption, want_kinds=want_kinds)
    if not missing["ids"]:
        return {"missing": 0, "requested": 0, "already_queued": 0, "eta_s": 0.0,
                "request_id": None, "needs": {"caption": want_caption,
                                              "kinds": sorted(want_kinds)}}
    ticket = request(missing["ids"], caption=want_caption, descriptors=bool(want_kinds))
    return {"missing": int(missing["total"]), "capped_at": request_cap(),
            **ticket, "needs": {"caption": want_caption, "kinds": sorted(want_kinds)}}


# ── the queue ─────────────────────────────────────────────────────

@dataclass
class Request:
    request_id: str
    event_ids: list[int]
    caption: bool
    descriptors: bool
    created_at: float = field(default_factory=time.monotonic)
    described: int = 0
    dropped: int = 0


_queue: asyncio.Queue[Request] | None = None
_inflight: set[int] = set()          # queued or being worked on
_pending_calls = 0                   # calls still ahead in the queue


def _q() -> asyncio.Queue[Request]:
    global _queue
    if _queue is None:
        _queue = asyncio.Queue()
    return _queue


def per_call_estimate() -> float:
    """Seconds per adapter call, from the slowest gate that has answered
    recently; the default before anything has."""
    from services.enrichment_gate import snapshot_all
    from services.enrichment_governor import SLOW_SIGNAL_TTL_S

    best = None
    for snap in snapshot_all():
        lat, age = snap.get("latency_ewma_s"), snap.get("latency_age_s")
        if lat is None or (age is not None and age > SLOW_SIGNAL_TTL_S):
            continue
        best = lat if best is None else max(best, lat)
    return float(best) if best is not None else DEFAULT_CALL_S


def request(event_ids: list[int], *, caption: bool, descriptors: bool) -> dict[str, Any]:
    """Queue visits for enrichment; return the ticket for the answer.

    ``{"request_id", "requested": n, "already_queued": m, "eta_s": s}``.
    ``requested`` is what THIS call added; visits already queued or in
    flight from an earlier question are not queued twice (a UI that
    searches on every keystroke must not multiply the work).
    """
    global _pending_calls
    calls_per_visit = (1 if caption else 0) + (2 if descriptors else 0)
    fresh = [int(e) for e in event_ids if int(e) not in _inflight]
    already = len(event_ids) - len(fresh)
    if not fresh or not calls_per_visit:
        eta = _pending_calls * per_call_estimate()
        return {"request_id": None, "requested": 0, "already_queued": already,
                "eta_s": round(eta, 1)}
    req = Request(request_id=uuid.uuid4().hex[:12], event_ids=fresh,
                  caption=caption, descriptors=descriptors)
    _inflight.update(fresh)
    _pending_calls += len(fresh) * calls_per_visit
    _q().put_nowait(req)
    eta = _pending_calls * per_call_estimate()
    logger.info("enrichment requests: %s queued %d visit(s) (caption=%s, "
                "descriptors=%s), ~%.0fs", req.request_id, len(fresh),
                caption, descriptors, eta)
    return {"request_id": req.request_id, "requested": len(fresh),
            "already_queued": already, "eta_s": round(eta, 1)}


def queue_depth() -> int:
    return len(_inflight)


# ── the worker ────────────────────────────────────────────────────

async def _wait_while_paused() -> None:
    from services.enrichment_governor import State, governor

    said = False
    while governor().evaluate() is State.PAUSED:
        if not said:
            logger.info("enrichment requests: holding — %s", governor().reason)
            said = True
        await asyncio.sleep(_PAUSED_POLL_S)


async def _one(event_id: int, req: Request) -> None:
    global _pending_calls
    from services.caption_enrichment import enrich_event_caption
    from services.descriptor_enrichment import enrich_event_descriptors

    steps = []
    if req.caption:
        steps.append(("caption", enrich_event_caption))
    if req.descriptors:
        steps.append(("descriptors", enrich_event_descriptors))
    for name, fn in steps:
        for attempt in range(_DROP_RETRIES + 1):
            await _wait_while_paused()
            try:
                res = await fn(event_id, priority="requested")
            except Exception:                      # noqa: BLE001
                logger.warning("enrichment requests: %s failed for %s", name,
                               event_id, exc_info=True)
                res = None
            if res != "dropped":
                break
            if attempt < _DROP_RETRIES:
                await asyncio.sleep(_DROP_RETRY_S)
        else:
            req.dropped += 1
        _pending_calls = max(0, _pending_calls - (1 if name == "caption" else 2))
    req.described += 1


async def _announce(req: Request) -> None:
    payload = {"request_id": req.request_id, "visits": len(req.event_ids),
               "described": req.described, "dropped": req.dropped,
               "took_s": round(time.monotonic() - req.created_at, 1)}
    logger.info("enrichment requests: %s done — %s", req.request_id, payload)
    try:
        from services.event_bus_service import publish_system_alert

        await publish_system_alert(alert_type=DONE_ALERT_TYPE, state=None,
                                   severity="info", payload=payload)
    except Exception:                              # noqa: BLE001
        logger.debug("enrichment requests: bus publish failed", exc_info=True)


async def process_one_request(req: Request) -> None:
    try:
        for event_id in req.event_ids:
            try:
                await _one(event_id, req)
            finally:
                _inflight.discard(event_id)
    finally:
        await _announce(req)


async def run_requests_worker() -> None:
    """Forever: take the next request, describe its visits in order."""
    logger.info("enrichment requests: worker started (cap %d per question)",
                request_cap())
    while True:
        req = await _q().get()
        try:
            await process_one_request(req)
        except asyncio.CancelledError:
            raise
        except Exception:                          # noqa: BLE001
            logger.warning("enrichment requests: request %s failed",
                           req.request_id, exc_info=True)


def _reset_for_tests() -> None:
    global _queue, _pending_calls
    _queue = None
    _inflight.clear()
    _pending_calls = 0
