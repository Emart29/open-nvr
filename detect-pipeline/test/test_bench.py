# Copyright (c) 2026 OpenNVR
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Unit tests for the baseline-vs-gated benchmark harness (synthetic tracks)."""
from __future__ import annotations

from detect_pipeline.bench import BenchResult, run_benchmark
from detect_pipeline.gate import GateConfig
from detect_pipeline.tracking import Track


def _moving():
    return Track(id=1, label="person", box=(10, 10, 30, 60), score=0.9,
                 hits=5, confirmed=True, motionless_count=0, stationary_threshold=50)


def _stationary(tid=2):
    return Track(id=tid, label="car", box=(50, 50, 90, 90), score=0.8,
                 hits=5, confirmed=True, motionless_count=100, stationary_threshold=50)


def test_moving_object_escalates_once_then_cooldown():
    # 30 frames @ 5fps = 6s, under the 30s cooldown -> one escalate (new_track)
    stream = [([_moving()], i * 0.2) for i in range(30)]
    r = run_benchmark(stream)
    assert r.baseline_calls == 30          # naive: one call per track per frame
    assert r.gated_calls == 1              # gated: once, on the new track
    assert r.escalations_by_reason == {"new_track": 1}
    assert r.events == 1 and r.missed_events == 0
    assert r.reduction_factor == 30


def test_stationary_object_suppressed_counts_as_missed():
    stream = [([_stationary()], i * 0.2) for i in range(10)]
    r = run_benchmark(stream)
    assert r.gated_calls == 0
    assert r.events == 1 and r.missed_events == 1
    assert r.miss_rate == 1.0
    assert r.baseline_calls == 10


def test_heartbeat_rescues_a_stationary_object():
    # A settled object is suppressed (see test above -> missed) UNLESS a heartbeat
    # forces a periodic escalate. With heartbeat on, the same object is not missed.
    stream = [([_stationary()], i * 0.2) for i in range(15)]   # 0..2.8s
    r = run_benchmark(stream, GateConfig(shadow=False, heartbeat_s=1.0))
    assert r.gated_calls >= 1
    assert "heartbeat" in r.escalations_by_reason
    assert r.missed_events == 0             # heartbeat means it wasn't missed


def test_result_dict_and_summary():
    r = BenchResult(frames=100, baseline_calls=300, gated_calls=3, events=3,
                    missed_events=0, escalations_by_reason={"new_track": 3})
    d = r.as_dict()
    assert d["reduction_factor"] == 100.0 and d["miss_rate"] == 0.0
    assert "100x fewer" in r.summary() or "100.0x fewer" in r.summary()


def test_fps_property_from_wall_time():
    r = BenchResult(frames=100, wall_seconds=2.0)
    assert r.fps == 50.0
    assert r.as_dict()["fps"] == 50.0
    assert "fps=50.0" in r.summary()
    # untimed run: fps is None, omitted from the summary line
    assert BenchResult(frames=100).fps is None
    assert "fps=" not in BenchResult(frames=100).summary()


# --- detector-only latency mode (per-device ms/frame) -----------------------

from types import SimpleNamespace

from detect_pipeline.bench import (
    detector_backend_info,
    detector_latency,
    frame_to_bgr,
    latency_stats,
)
from detect_pipeline.frame_source import Frame


def test_latency_stats_median_p90_min():
    s = latency_stats([10.0, 8.0, 9.0, 30.0, 7.0, 8.5, 9.5, 8.0, 7.5, 9.0])
    assert s["n"] == 10
    assert s["median_ms"] == 8.75
    assert s["min_ms"] == 7.0
    assert s["p90_ms"] == 10.0          # the one 30 ms outlier sits above p90
    assert latency_stats([])["median_ms"] is None


class _CountingDetector:
    def __init__(self):
        self.calls = 0

    def detect(self, img):
        self.calls += 1
        return []


def _ticking_clock(step=0.005):
    t = [0.0]

    def clock():
        t[0] += step
        return t[0]
    return clock


def test_detector_latency_skips_warmup_and_cycles_a_short_source():
    det = _CountingDetector()
    samples = detector_latency(
        ["a", "b", "c"], det, n=20, warmup=5, to_image=lambda f: f, clock=_ticking_clock(),
    )
    assert det.calls == 25              # warm-up runs happen, untimed
    assert len(samples) == 20           # a 3-frame source still yields n samples
    assert all(abs(x - 5.0) < 1e-6 for x in samples)


def test_detector_latency_reads_a_live_source_only_as_far_as_needed():
    def endless():
        i = 0
        while True:
            yield i
            i += 1
    taken = []
    detector_latency(endless(), _CountingDetector(), n=3, warmup=2,
                     to_image=lambda f: taken.append(f) or f)
    assert taken == [0, 1, 2, 3, 4]


def test_detector_latency_empty_source_raises():
    import pytest

    with pytest.raises(RuntimeError):
        detector_latency([], _CountingDetector(), n=3, warmup=0, to_image=lambda f: f)


def test_frame_to_bgr_shape():
    w, h = 8, 4
    img = frame_to_bgr(Frame(bytes(w * h * 3 // 2), w, h, 0, 0.0))
    assert img.shape == (h, w, 3)


def _det(effective, fallback_error=None):
    return SimpleNamespace(backend_name="ort", _backend=SimpleNamespace(
        effective=effective, fallback_error=fallback_error))


def test_backend_info_on_the_npu():
    info = detector_backend_info(
        _det(["OpenVINOExecutionProvider", "CPUExecutionProvider"]),
        "OpenVINOExecutionProvider:NPU",
    )
    assert info["fell_back"] is False
    assert info["requested"] == "OpenVINOExecutionProvider:NPU"
    assert info["effective"].startswith("OpenVINOExecutionProvider")


def test_backend_info_flags_a_provider_the_wheel_does_not_carry():
    # resolve_providers dropped OpenVINO before the session; the backend's own
    # `requested` says CPU, so only the --providers value reveals the fallback.
    info = detector_backend_info(_det(["CPUExecutionProvider"]), "OpenVINOExecutionProvider:NPU")
    assert info["fell_back"] is True


def test_backend_info_flags_a_session_that_failed_to_build():
    info = detector_backend_info(
        _det(["CPUExecutionProvider"], "RuntimeError: no NPU"), "OpenVINOExecutionProvider:NPU",
    )
    assert info["fell_back"] is True
    assert info["fallback_error"] == "RuntimeError: no NPU"


def test_backend_info_cpu_baseline_is_not_a_fallback():
    assert detector_backend_info(_det(["CPUExecutionProvider"]), "CPUExecutionProvider")["fell_back"] is False
    assert detector_backend_info(_det([]), None)["fell_back"] is False
