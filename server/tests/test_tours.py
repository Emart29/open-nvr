# Copyright (c) 2026 OpenNVR
# Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0)
"""Live View tours (routers/tours.py).

* CRUD is audited; a bad camera or layout is a 422 naming what is wrong;
* every read is filtered to the caller's cameras, binned cameras drop out,
  and a layout deleted or disabled later is flagged, never an error;
* running needs live.view, changing needs cameras.manage; a manager who
  cannot see every camera in a tour may not overwrite it; tokens get 403;
* a stale revision is a 409; a corrupt window-settings row degrades to the
  predefined layouts instead of failing.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime

from tests.test_api_tokens import _as, _mint, env  # noqa: F401 - shared fixture

URL = "/api/v1/tours"


def _body(**kw):
    body = {"name": "Ops wall", "steps": [
        {"label": "North", "layout_id": "2x2", "duration_s": 30, "camera_ids": [1, 2]},
        {"label": "South", "layout_id": "1x1", "duration_s": 60, "camera_ids": [3]},
    ]}
    body.update(kw)
    return body


def _create(env, **kw):  # noqa: F811
    r = env.client.post(URL, headers=env.jwt("admin"), json=_body(**kw))
    assert r.status_code == 201, r.text
    return r.json()


def _window_settings(env, value):  # noqa: F811
    s = env.Session()
    s.add(env.models.SecuritySetting(key="window_division_settings",
                                     json_value=value if isinstance(value, str)
                                     else json.dumps(value)))
    s.commit()
    s.close()


def _operator(env, *, view=(1,), manage=(1,)):  # noqa: F811
    """olga: cameras.manage + live.view, scoped to the given cameras."""
    m = env.models
    s = env.Session()
    perms = {p.name: p for p in s.query(m.Permission).all()}
    role = m.Role(name="operator")
    s.add(role)
    s.commit()
    for n in ("cameras.view", "cameras.manage", "live.view"):
        s.add(m.RolePermission(role_id=role.id, permission_id=perms[n].id))
    u = m.User(username="olga", email="o@x", hashed_password="h", is_active=True,
               is_superuser=False, role_id=role.id)
    s.add(u)
    s.commit()
    for cid in set(view) | set(manage):
        s.add(m.CameraPermission(user_id=u.id, camera_id=cid, can_view=cid in view,
                                 can_manage=cid in manage))
    s.commit()
    s.close()
    return env.jwt("olga")


# ── CRUD ─────────────────────────────────────────────────────────────


def test_tour_crud_is_audited(env):  # noqa: F811
    A = env.jwt("admin")
    t = _create(env, name="  Ops wall ")
    assert t["name"] == "Ops wall" and t["revision"] == 1 and t["editable"]
    assert [s["camera_ids"] for s in t["steps"]] == [[1, 2], [3]]
    assert env.client.get(URL, headers=A).json()["tours"][0]["id"] == t["id"]

    r = env.client.put(f"{URL}/{t['id']}", headers=A,
                       json=_body(name="Night", expected_revision=1))
    assert r.status_code == 200 and r.json()["name"] == "Night" and r.json()["revision"] == 2
    assert env.client.delete(f"{URL}/{t['id']}", headers=A).status_code == 200
    assert env.client.get(f"{URL}/{t['id']}", headers=A).status_code == 404

    s = env.Session()
    actions = [a for (a,) in s.query(env.models.AuditLog.action)
               .filter(env.models.AuditLog.action.like("tour.%"))
               .order_by(env.models.AuditLog.id).all()]
    s.close()
    assert actions == ["tour.create", "tour.update", "tour.delete"]


def test_step_keeps_order_and_drops_duplicates(env):  # noqa: F811
    t = _create(env, steps=[{"layout_id": "2x2", "camera_ids": [3, 1, 3, 2]}])
    assert t["steps"][0]["camera_ids"] == [3, 1, 2]
    assert t["steps"][0]["duration_s"] == 60


def test_bad_bodies_are_422(env):  # noqa: F811
    A = env.jwt("admin")
    for body in (_body(name="  "),
                 _body(steps=[]),
                 _body(steps=[{"layout_id": "2x2", "camera_ids": []}]),
                 _body(steps=[{"layout_id": "2x2", "duration_s": 5, "camera_ids": [1]}])):
        assert env.client.post(URL, headers=A, json=body).status_code == 422


def test_unknown_or_binned_cameras_are_named(env):  # noqa: F811
    s = env.Session()
    s.get(env.models.Camera, 2).deleted_at = datetime.now(UTC)
    s.commit()
    s.close()
    r = env.client.post(URL, headers=env.jwt("admin"),
                        json=_body(steps=[{"layout_id": "2x2", "camera_ids": [1, 2, 99]}]))
    assert r.status_code == 422
    assert r.json()["detail"]["camera_ids"] == [2, 99]


def test_unknown_and_disabled_layouts_are_422(env):  # noqa: F811
    _window_settings(env, {"layouts_enabled": {"3x3": False}, "custom_layouts": [
        {"id": "wall", "name": "Wall", "grid_columns": 5, "grid_rows": 4, "enabled": True},
        {"id": "old", "name": "Old", "grid_columns": 2, "grid_rows": 1, "enabled": False},
    ]})
    A = env.jwt("admin")
    for bad in ("nope", "3x3", "old"):
        r = env.client.post(URL, headers=A,
                            json=_body(steps=[{"layout_id": bad, "camera_ids": [1]}]))
        assert r.status_code == 422 and r.json()["detail"]["layout_ids"] == [bad]
    assert env.client.post(URL, headers=A, json=_body(
        steps=[{"layout_id": "wall", "camera_ids": [1]}])).status_code == 201


def test_a_plain_grid_needs_no_window_settings(env):  # noqa: F811
    A = env.jwt("admin")
    t = _create(env, steps=[{"layout_id": "grid:5x4", "camera_ids": [1]}])
    assert t["steps"][0]["layout_missing"] is False
    for bad in ("grid:9x1", "grid:0x2", "grid:5x4x", "grid:"):
        assert env.client.post(URL, headers=A, json=_body(
            steps=[{"layout_id": bad, "camera_ids": [1]}])).status_code == 422


# ── reads degrade, never fail ────────────────────────────────────────


def test_a_binned_camera_drops_out_of_a_running_tour(env):  # noqa: F811
    t = _create(env)
    s = env.Session()
    s.get(env.models.Camera, 2).deleted_at = datetime.now(UTC)
    s.get(env.models.Camera, 1).is_active = False
    s.commit()
    s.close()
    step = env.client.get(f"{URL}/{t['id']}", headers=env.jwt("admin")).json()["steps"][0]
    assert step["camera_ids"] == [1]
    assert step["paused_camera_ids"] == [1]
    assert step["hidden_count"] == 1


def test_a_layout_removed_later_is_flagged(env):  # noqa: F811
    _window_settings(env, {"custom_layouts": [
        {"id": "wall", "name": "Wall", "grid_columns": 5, "grid_rows": 4}]})
    t = _create(env, steps=[{"layout_id": "wall", "camera_ids": [1]}])
    assert t["steps"][0]["layout_missing"] is False
    s = env.Session()
    row = s.query(env.models.SecuritySetting).filter_by(key="window_division_settings").one()
    row.json_value = json.dumps({"custom_layouts": [
        {"id": "wall", "name": "Wall", "grid_columns": 5, "grid_rows": 4, "enabled": False}]})
    s.commit()
    s.close()
    step = env.client.get(f"{URL}/{t['id']}", headers=env.jwt("admin")).json()["steps"][0]
    assert step["layout_missing"] is True and step["camera_ids"] == [1]


def test_corrupt_window_settings_fall_back_to_predefined_layouts(env):  # noqa: F811
    _window_settings(env, '{"custom_layouts": [{"id": 1}]}')  # fails validation
    t = _create(env)  # predefined layouts still accepted
    got = env.client.get(f"{URL}/{t['id']}", headers=env.jwt("admin"))
    assert got.status_code == 200
    assert [s["layout_missing"] for s in got.json()["steps"]] == [False, False]


# ── who may do what ──────────────────────────────────────────────────


def test_a_viewer_runs_a_tour_with_only_their_cameras(env):  # noqa: F811
    t = _create(env)
    V = env.jwt("vera")  # live.view, sees camera 3 only, no cameras.manage
    got = env.client.get(f"{URL}/{t['id']}", headers=V).json()
    assert [s["camera_ids"] for s in got["steps"]] == [[], [3]]
    assert [s["hidden_count"] for s in got["steps"]] == [2, 0]
    assert env.client.get(URL, headers=V).status_code == 200
    assert env.client.post(URL, headers=V, json=_body()).status_code == 403
    assert env.client.put(f"{URL}/{t['id']}", headers=V, json=_body()).status_code == 403
    assert env.client.delete(f"{URL}/{t['id']}", headers=V).status_code == 403


def test_a_manager_cannot_overwrite_a_tour_with_cameras_they_cannot_see(env):  # noqa: F811
    t = _create(env)
    O = _operator(env, view=(1,), manage=(1,))
    got = env.client.get(f"{URL}/{t['id']}", headers=O).json()
    assert got["editable"] is False
    assert env.client.put(f"{URL}/{t['id']}", headers=O, json=_body(
        steps=[{"layout_id": "1x1", "camera_ids": [1]}])).status_code == 403
    assert env.client.delete(f"{URL}/{t['id']}", headers=O).status_code == 403
    # …and may only put cameras they manage into a tour of their own.
    r = env.client.post(URL, headers=O, json=_body(
        steps=[{"layout_id": "1x1", "camera_ids": [1, 2]}]))
    assert r.status_code == 422 and r.json()["detail"]["camera_ids"] == [2]
    assert env.client.post(URL, headers=O, json=_body(
        steps=[{"layout_id": "1x1", "camera_ids": [1]}])).status_code == 201


def test_a_stale_revision_is_409(env):  # noqa: F811
    t = _create(env)
    A = env.jwt("admin")
    assert env.client.put(f"{URL}/{t['id']}", headers=A,
                          json=_body(expected_revision=1)).status_code == 200
    r = env.client.put(f"{URL}/{t['id']}", headers=A, json=_body(expected_revision=1))
    assert r.status_code == 409


def test_tokens_cannot_reach_tours(env):  # noqa: F811
    _create(env)
    tok = _mint(env, scopes=["live.view", "cameras.manage"])["token"]
    assert env.client.get(URL, headers=_as(tok)).status_code == 403
    assert env.client.post(URL, headers=_as(tok), json=_body()).status_code == 403
