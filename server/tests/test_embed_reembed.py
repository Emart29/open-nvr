"""A model change behind the embedding adapter re-embeds the store.

``event_embeddings.model`` records the producer as ``<adapter>:<model
version>``; a vector from another producer is replaced by the enricher,
and the backfill walks history again when any such vector exists. The
case this guards: CLIP (512 wide) → SigLIP 2 (768 wide) behind the same
``clip`` adapter name, which search would otherwise skip row by row (a
dimension mismatch is a non-match) for as long as the old vectors sat
there.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import os
import secrets
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

os.environ.setdefault("INTERNAL_API_KEY", "site_" + secrets.token_hex(16))
os.environ.setdefault("SECRET_KEY", secrets.token_urlsafe(48))
os.environ.setdefault("MEDIAMTX_SECRET", secrets.token_hex(32))
os.environ.setdefault("DATABASE_URL", "sqlite:///./_reembed_test.db")

from cryptography.fernet import Fernet  # noqa: E402

os.environ.setdefault("CREDENTIAL_ENCRYPTION_KEY", Fernet.generate_key().decode())

from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402
from sqlalchemy.pool import StaticPool  # noqa: E402

from core.database import Base  # noqa: E402
from models import Camera, EventEmbedding, Role, TimelineEvent, User  # noqa: E402
from services import embedding_store  # noqa: E402

T0 = datetime(2026, 10, 16, 8, 0, tzinfo=timezone.utc)
OLD = "clip:open_clip/ViT-B-32/laion2b_s34b_b79k"
NEW = "clip:open_clip/ViT-B-16-SigLIP2-256/webli"
#: What the clip adapter's /capabilities actually reports: the
#: architecture as the model name, the pretrained tag as the version.
NEW_CAPS = {"model": {"name": "open_clip/ViT-B-16-SigLIP2-256", "version": "webli"}}


@pytest.fixture()
def session_local(monkeypatch):
    engine = create_engine("sqlite://", future=True, poolclass=StaticPool,
                           connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine)
    import core.database as core_db
    monkeypatch.setattr(core_db, "SessionLocal", factory)
    s = factory()
    s.add(Role(id=1, name="admin", description="t")); s.commit()
    s.add(User(id=1, username="o", email="o@x.t", hashed_password="x", is_active=True, role_id=1)); s.commit()
    s.add(Camera(id=1, name="Yard", ip_address="10.0.0.1", rtsp_url="rtsp://x/1", owner_id=1)); s.commit()
    yield factory
    s.close()


def _visit(db, *, vec=None, model=OLD) -> int:
    row = TimelineEvent(camera_id=1, label="truck", event_type="visit", source="tier0",
                        started_at=T0, ended_at=T0 + timedelta(seconds=20),
                        evidence_path="x/y.jpg")
    db.add(row); db.commit()
    if vec is not None:
        embedding_store.put_embedding(db, event_id=row.id, vector=vec, model=model)
    return row.id


def _wire(monkeypatch, producer: str, vector: list[float], calls: list):
    import services.embed_enrichment as emb
    from core.config import settings
    monkeypatch.setattr(settings, "events_embed_enrichment", True, raising=False)

    async def _producer():
        return "clip", producer

    async def _infer(adapter, payload, *, what, **kw):
        calls.append(what)
        return list(vector)

    monkeypatch.setattr(emb, "_resolve_embed_producer", _producer)
    monkeypatch.setattr(emb, "_infer", _infer)
    return emb


def test_producer_identity_is_adapter_and_model_version():
    from services.embed_enrichment import producer_identity
    assert producer_identity("clip", NEW_CAPS) == NEW
    assert producer_identity("clip", {"model": {"version": "v2"}}) == "clip:v2"
    assert producer_identity("clip", {}) == "clip"
    assert producer_identity("clip", {"model": {"version": "  "}}) == "clip"


def test_a_vector_from_another_producer_is_replaced_and_the_same_one_is_kept(session_local, monkeypatch):
    calls: list = []
    emb = _wire(monkeypatch, NEW, [0.0, 1.0, 0.0, 0.0, 0.0, 0.0], calls)
    db = session_local()
    eid = _visit(db, vec=[1.0, 0.0, 0.0, 0.0], model=OLD)   # 4 wide, the old model
    db.close()

    asyncio.run(emb.enrich_event_embedding(eid, evidence_jpeg=b"jpg"))
    db = session_local()
    row = db.get(EventEmbedding, eid)
    assert row.model == NEW and row.dim == 6 and calls == [f"event {eid}"]
    db.close()

    # Same producer again: already embedded, nothing called.
    asyncio.run(emb.enrich_event_embedding(eid, evidence_jpeg=b"jpg"))
    assert calls == [f"event {eid}"]


def test_stale_rows_counts_other_producers_and_unlabelled(session_local):
    db = session_local()
    _visit(db, vec=[1.0, 0.0], model=OLD)
    _visit(db, vec=[0.0, 1.0], model=NEW)
    _visit(db, vec=[1.0, 1.0], model=None)
    assert embedding_store.stale_rows(db, NEW) == 2
    assert embedding_store.stale_rows(db, OLD) == 2
    db.close()


def test_reembed_due_only_when_the_store_holds_another_producer(session_local, monkeypatch):
    import services.enrichment_backfill as bf
    _wire(monkeypatch, NEW, [0.0, 1.0], [])
    db = session_local()
    _visit(db, vec=[0.0, 1.0], model=NEW)
    db.close()
    assert asyncio.run(bf.reembed_due()) == (False, NEW)
    db = session_local()
    _visit(db, vec=[1.0, 0.0], model=OLD)
    db.close()
    assert asyncio.run(bf.reembed_due()) == (True, NEW)


def test_reembed_due_is_quiet_with_embedding_off_or_no_adapter(session_local, monkeypatch):
    import services.enrichment_backfill as bf
    import services.embed_enrichment as emb
    from core.config import settings
    monkeypatch.setattr(settings, "events_embed_enrichment", False, raising=False)
    assert asyncio.run(bf.reembed_due()) == (False, None)
    monkeypatch.setattr(settings, "events_embed_enrichment", True, raising=False)

    async def _none():
        return None
    monkeypatch.setattr(emb, "_resolve_embed_producer", _none)
    assert asyncio.run(bf.reembed_due()) == (False, None)


def test_reset_for_reembed_starts_the_walk_over(session_local):
    import services.enrichment_backfill as bf
    db = session_local()
    bf._write_state(db, {"done": True, "cursor": 7, "top": 99, "examined": 42})
    state = bf.reset_for_reembed(db, NEW)
    assert state == {"reembed_for": NEW}
    assert bf.read_state(db) == {"reembed_for": NEW}
    db.close()
