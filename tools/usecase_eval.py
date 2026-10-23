#!/usr/bin/env python3
# Copyright (c) 2026 OpenNVR
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Score a use case end to end: play labelled clips through the fake-camera
rig, read the alerts inbox, compare with what each clip's ``expected.yml``
says should (and should not) have fired.

One folder per use case under ``data/fake-cameras/`` (gitignored). Beside
each clip sits ``<clip>.expected.yml``::

    use_case: intrusion
    apps: [intrusion-detection]          # picked for the eval camera before the clip plays
    expect:
      - alert_type: intrusion             # the app's alert type (apps_index.yml "emits")
        title_contains: ""                # optional substring, e.g. a plate number
        at_seconds: 12                    # when the event happens in the clip (0 = anywhere)
        within_seconds: 10                # tolerance after at_seconds (alert delay budget)
    no_alerts: [loitering]                # alert types that must NOT fire during this clip
    strict: false                         # true: an alert of an expected type whose title matches no
                                          # expected entry is a false positive (misread plates)
    config:                               # optional: app config applied before the clip (PUT /apps/{id}/config)
      intrusion-detection: {arm_mode: always}
    settle_seconds: 15                    # extra wait after the clip's length (default 20)

The harness stages one clip at a time as the camera ``_eval`` (the rig
turns a folder into a looping RTSP stream), waits the clip's length plus
the settle time, then scores the inbox rows that fired meanwhile. Every
expected event found inside its window is a true positive; an expected
event not found is a miss; any alert of a ``no_alerts`` type is a false
positive. Alert delay is fired_at minus (clip start + at_seconds).

Usage::

    python tools/usecase_eval.py --token "$TOKEN" data/fake-cameras/anpr
    python tools/usecase_eval.py --token "$TOKEN" --all data/fake-cameras

The token is a bearer from POST /api/v1/auth/login-json. ``--json`` writes the
rows the evidence pack is built from.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx
import yaml

EVAL_CAMERA = "eval-cam"
FAKECAM_IP = os.getenv("FAKECAM_IP", "172.28.90.10")


# ── OpenNVR API ────────────────────────────────────────────────────────

class Api:
    """Thin client. Access tokens are short-lived; with a refresh token the
    client re-authenticates on the first 401 and retries the call once."""

    def __init__(self, base: str, token: str, refresh_token: str | None = None) -> None:
        self.c = httpx.Client(base_url=base.rstrip("/"), timeout=30,
                              headers={"Authorization": f"Bearer {token}"})
        self.refresh_token = refresh_token

    def _refresh(self) -> bool:
        if not self.refresh_token:
            return False
        r = self.c.post("/api/v1/auth/refresh", json={"refresh_token": self.refresh_token})
        if r.status_code != 200:
            return False
        body = r.json()
        self.c.headers["Authorization"] = f"Bearer {body['access_token']}"
        self.refresh_token = body.get("refresh_token", self.refresh_token)
        print("  (access token refreshed)", flush=True)
        return True

    def _call(self, method: str, p: str, body=None, params=None):
        r = self.c.request(method, p, json=body, params=params)
        if r.status_code == 401 and self._refresh():
            r = self.c.request(method, p, json=body, params=params)
        r.raise_for_status()
        return r.json() if r.content else None

    def get(self, p: str, **params):
        return self._call("GET", p, params=params)

    def post(self, p: str, body=None):
        return self._call("POST", p, body)

    def put(self, p: str, body=None, **params):
        return self._call("PUT", p, body, params)

    def ensure_eval_camera(self) -> int:
        listing = self.get("/api/v1/cameras/")
        cams = listing if isinstance(listing, list) else (listing.get("cameras") or listing.get("items") or [])
        for cam in cams:
            if isinstance(cam, dict) and cam.get("name") == EVAL_CAMERA:
                return int(cam["id"])
        cam = self.post("/api/v1/cameras/", {
            "name": EVAL_CAMERA, "ip_address": FAKECAM_IP, "port": 8554,
            "rtsp_url": f"rtsp://{FAKECAM_IP}:8554/{EVAL_CAMERA}"})
        return int(cam["id"])

    def installed_apps(self) -> list[str]:
        apps = self.get("/api/v1/apps")
        return [a.get("id") for a in (apps if isinstance(apps, list) else apps.get("apps", [])) if a.get("id")]

    def unpick_camera_for_app(self, app_id: str, camera_id: int) -> None:
        try:
            skill = self.get(f"/api/v1/apps/{app_id}/cameras").get("skill")
            if skill:
                self.c.delete(f"/api/v1/skills/{skill}/cameras/{camera_id}", params={"consumer": f"app:{app_id}"})
        except httpx.HTTPError:
            pass

    def pick_camera_for_app(self, app_id: str, camera_id: int) -> None:
        info = self.get(f"/api/v1/apps/{app_id}/cameras")
        skill = info.get("skill")
        if not skill:
            raise SystemExit(f"{app_id}: no camera-picking skill; is the app installed and running?")
        self.put(f"/api/v1/skills/{skill}/cameras/{camera_id}",
                 {"consumer": f"app:{app_id}"}, consumer=f"app:{app_id}")

    def alerts_since(self, start: datetime, camera_id: int) -> list[dict]:
        rows, skip = [], 0
        while True:
            page = self.get("/api/v1/alerts-inbox", **{"from": start.isoformat(), "limit": 200, "skip": skip})
            items = page.get("alerts", page if isinstance(page, list) else [])
            rows += [a for a in items if str(a.get("camera_id")) in (str(camera_id), f"cam{camera_id}", f"cam-{camera_id}", "", "None")]
            if len(items) < 200:
                return rows
            skip += 200


# ── clips ─────────────────────────────────────────────────────────────

def clip_seconds(path: Path) -> float:
    """ffprobe on the host if present, else the ffmpeg image already pulled for the rig."""
    cmd = ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)]
    if shutil.which("ffprobe") is None:
        cmd = ["docker", "run", "--rm", "-v", f"{path.parent}:/v:ro", "--entrypoint", "ffprobe",
               "bluenviron/mediamtx:1.15.4-ffmpeg", "-v", "error", "-show_entries", "format=duration",
               "-of", "csv=p=0", f"/v/{path.name}"]
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=120).stdout.strip()
    return float(out or 0) or 30.0


def stage(clip: Path, rig_dir: Path) -> Path:
    d = rig_dir / EVAL_CAMERA
    if d.exists():
        shutil.rmtree(d)
    d.mkdir(parents=True)
    shutil.copy(clip, d / clip.name)
    return d


def unstage(rig_dir: Path) -> None:
    shutil.rmtree(rig_dir / EVAL_CAMERA, ignore_errors=True)


def fired_at(a: dict) -> datetime | None:
    raw = a.get("fired_at") or a.get("created_at")
    if not raw:
        return None
    try:
        dt = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


# ── scoring ────────────────────────────────────────────────────────────

def score_clip(spec: dict, alerts: list[dict], start: datetime) -> dict:
    hits, misses, delays = [], [], []
    for exp in spec.get("expect", []):
        want_type = exp.get("alert_type")
        want_sub = (exp.get("title_contains") or "").upper()
        t0 = start.timestamp() + float(exp.get("at_seconds", 0))
        t1 = t0 + float(exp.get("within_seconds", 30)) if exp.get("at_seconds", 0) else float("inf")
        found = None
        for a in alerts:
            if want_type and a.get("alert_type") not in (want_type, None):
                continue
            if a.get("alert_type") is None and not want_sub:
                continue                        # untyped rows count only when a title is asked for
            if want_sub and want_sub not in str(a.get("title", "")).upper():
                continue
            fa = fired_at(a)
            if fa is None or not (t0 - 2 <= fa.timestamp() <= t1):
                continue
            found = a
            break
        if found:
            hits.append(exp)
            fa = fired_at(found)
            if fa and exp.get("at_seconds", 0):
                delays.append(round(fa.timestamp() - t0, 1))
        else:
            misses.append(exp)
    false_pos = [a for a in alerts if a.get("alert_type") in set(spec.get("no_alerts", []))]
    if spec.get("strict"):
        subs = [(e.get("title_contains") or "").upper() for e in spec.get("expect", [])]
        types = {e.get("alert_type") for e in spec.get("expect", [])}
        for a in alerts:
            if a.get("alert_type") in types or a.get("alert_type") is None:
                title = str(a.get("title", "")).upper()
                if subs and not any(sub and sub in title for sub in subs):
                    false_pos.append(a)
    return {"hits": len(hits), "misses": len(misses), "false_positives": len(false_pos),
            "expected": len(spec.get("expect", [])), "delays_s": delays,
            "fired": [(a.get("alert_type"), a.get("title")) for a in alerts][:20],
            "false_positive_titles": [a.get("title") for a in false_pos][:10],
            "missed": [(m.get("alert_type"), m.get("title_contains")) for m in misses]}


def run_folder(api: Api, folder: Path, rig_dir: Path, camera_id: int) -> list[dict]:
    rows = []
    specs = sorted(folder.glob("*.expected.yml"))
    if not specs:
        print(f"  {folder.name}: no *.expected.yml files, skipped")
        return rows
    for spec_path in specs:
        spec = yaml.safe_load(spec_path.read_text()) or {}
        clip = folder / spec_path.name.replace(".expected.yml", "")
        if not clip.exists():
            print(f"  {spec_path.name}: clip {clip.name} missing, skipped")
            continue
        wanted = set(spec.get("apps", []))
        for app_id in api.installed_apps():
            if app_id not in wanted:
                api.unpick_camera_for_app(app_id, camera_id)
        for app_id in wanted:
            api.pick_camera_for_app(app_id, camera_id)
        for app_id, cfg in (spec.get("config") or {}).items():
            current = api.get(f"/api/v1/apps/{app_id}/config").get("config") or {}
            api.put(f"/api/v1/apps/{app_id}/config", {**current, **cfg})
        length = clip_seconds(clip)
        settle = float(spec.get("settle_seconds", 20))
        stage(clip, rig_dir)
        start = datetime.now(timezone.utc)              # the window opens with the stream: a first-loop alert must count
        pickup = 25                                     # rig scan, stream start, MediaMTX source retry, detector pickup
        print(f"  {clip.name}: playing {length:.0f}s (+{pickup}s pickup, +{settle:.0f}s settle)", flush=True)
        time.sleep(pickup + length + settle)
        alerts = api.alerts_since(start, camera_id)
        unstage(rig_dir)
        time.sleep(8)
        res = score_clip(spec, alerts, start)
        res.update({"use_case": spec.get("use_case", folder.name), "clip": clip.name})
        verdict = "PASS" if res["misses"] == 0 and res["false_positives"] == 0 else "FAIL"
        print(f"    {verdict}  hits {res['hits']}/{res['expected']}  false+ {res['false_positives']}"
              f"  delays {res['delays_s']}  fired {res['fired'][:4]}", flush=True)
        rows.append(res)
    return rows


def summarise(rows: list[dict]) -> None:
    by: dict[str, dict] = {}
    for r in rows:
        s = by.setdefault(r["use_case"], {"clips": 0, "pass": 0, "exp": 0, "hit": 0, "fp": 0, "delays": []})
        s["clips"] += 1
        s["exp"] += r["expected"]
        s["hit"] += r["hits"]
        s["fp"] += r["false_positives"]
        s["pass"] += int(r["misses"] == 0 and r["false_positives"] == 0)
        s["delays"] += r["delays_s"]
    print("\nuse case            clips  pass  recall      false+  median delay")
    for uc, s in by.items():
        rec = f"{s['hit']}/{s['exp']}" if s["exp"] else "n/a"
        med = sorted(s["delays"])[len(s["delays"]) // 2] if s["delays"] else "n/a"
        print(f"{uc:19s} {s['clips']:5d}  {s['pass']:4d}  {rec:10s}  {s['fp']:6d}  {med}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("folder", type=Path, help="a use-case folder, or the fake-cameras root with --all")
    ap.add_argument("--all", action="store_true", help="run every use-case folder under the root")
    ap.add_argument("--base", default=os.getenv("OPENNVR_URL", "http://localhost:8000"))
    ap.add_argument("--token", default=os.getenv("OPENNVR_TOKEN"), help="bearer token (POST /api/v1/auth/login-json)")
    ap.add_argument("--refresh-token", default=os.getenv("OPENNVR_REFRESH_TOKEN"),
                    help="refresh token from the same login; lets a long run outlive the access token")
    ap.add_argument("--rig-dir", type=Path, default=None, help="data/fake-cameras (default: the folder's parent)")
    ap.add_argument("--json", type=Path, default=None, help="write per-clip rows here")
    args = ap.parse_args()
    if not args.token:
        ap.error("--token or OPENNVR_TOKEN is required")
    api = Api(args.base, args.token, args.refresh_token)
    folders = sorted(p for p in args.folder.iterdir() if p.is_dir() and not p.name.startswith(("_", ".")) and p.name != EVAL_CAMERA) if args.all else [args.folder]
    rig_dir = args.rig_dir or (args.folder if args.all else args.folder.parent)
    camera_id = api.ensure_eval_camera()
    print(f"eval camera {EVAL_CAMERA} = id {camera_id}; rig dir {rig_dir}")
    rows: list[dict] = []
    try:
        for f in folders:
            print(f"\n== {f.name}")
            rows += run_folder(api, f, rig_dir, camera_id)
    finally:
        unstage(rig_dir)
    summarise(rows)
    if args.json:
        args.json.write_text(json.dumps(rows, indent=1, default=str))
        print(f"\nrows written to {args.json}")
    return 0 if all(r["misses"] == 0 and r["false_positives"] == 0 for r in rows) else 1


if __name__ == "__main__":
    sys.exit(main())
