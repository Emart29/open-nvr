"""The four rules for a fast turn on CPU (MODELS_AND_LATENCY.md).

A field trace read `stt 14s → llm 17s → search_history 12s → llm 2.6s →
tts 25s · 71s`. Each rule below removes one structural cause; each test
pins the rule, not the timing.
"""
from __future__ import annotations

import asyncio
import base64
from types import SimpleNamespace

from adapter_clients import PiperClient, WhisperClient
from camera_agent import AppConfig, CameraAgentRuntime, load_config
from context import CameraContext, CameraSpec
from tools import CameraTools


def _runtime():
    cfg = AppConfig(kaic_url="http://k", kaic_api_key="x", system_prompt="t", text_mode=True,
                    cameras=[CameraSpec(camera_id="cam1", frame_url="http://x/1.jpg",
                                        role="front door", opennvr_camera_id=7)])
    return CameraAgentRuntime(cfg)


# ── 1. the prompt's static prefix is byte-identical across turns ──────

def test_the_clock_is_the_last_paragraph_of_the_prompt():
    """Ollama's KV cache survives only an unchanged prefix. The clock line
    changes every minute, so it must be the TAIL — with it near the top,
    every turn re-prefilled the whole tool prompt (17 s on the field box)."""
    prompt = _runtime().build_system_prompt()
    marker = "The current date and time is"
    assert marker in prompt
    assert prompt.strip().split("\n\n")[-1].startswith(marker), (
        "the clock must be the last paragraph; nothing may follow it")
    # ...except a thinking model's constant control switch.
    rt = _runtime(); rt.cfg.llm_think = False
    tail = rt.build_system_prompt().strip().split("\n\n")
    assert tail[-1] == "/no_think" and tail[-2].startswith(marker)
    assert prompt.index(marker) > prompt.index("Cameras available to you")
    assert prompt.index(marker) > prompt.index("SPOKEN ALOUD")


def test_two_builds_share_everything_before_the_clock():
    rt = _runtime()
    a, b = rt.build_system_prompt(), rt.build_system_prompt()
    marker = "The current date and time is"
    assert a[:a.index(marker)] == b[:b.index(marker)]
    assert len(a[:a.index(marker)]) > 500, "the cacheable prefix is the bulk of the prompt"


# ── 2. Whisper runs greedy ────────────────────────────────────────────

class _Resp:
    def __init__(self, payload):
        self._p = payload

    def raise_for_status(self):
        pass

    def json(self):
        return self._p


class _Http:
    def __init__(self, payload):
        self.payload, self.calls = payload, []

    async def post(self, url, json=None, headers=None):
        self.calls.append((url, json, headers))
        return _Resp(self.payload)


def test_whisper_is_asked_for_a_greedy_decode():
    c = WhisperClient(url="http://w:9003", token="")
    c._http = _Http({"result": {"text": "is anyone at the door"}})
    text = asyncio.run(c.transcribe(b"RIFFwav"))
    assert text.strip() == "is anyone at the door"
    (_, body, _), = c._http.calls
    assert body["beam_size"] == 1, "beam 5 is 30-50% more CPU for nothing on a short clip"
    assert body["vad_filter"] is False


# ── 3. the Piper voice is asked for per request ───────────────────────

def test_the_configured_voice_rides_every_synthesis_request():
    wav = base64.b64encode(b"RIFF").decode()
    c = PiperClient(url="http://p:9001", token="", voice="en_US-lessac-medium")
    c._http = _Http({"result": {"audio_b64": wav}})
    assert asyncio.run(c.synthesize("hello")) == b"RIFF"
    (_, body, _), = c._http.calls
    assert body["voice"] == "en_US-lessac-medium"

    d = PiperClient(url="http://p:9001", token="")
    d._http = _Http({"result": {"audio_b64": wav}})
    asyncio.run(d.synthesize("hello"))
    assert "voice" not in d._http.calls[0][1], "unset = the adapter's own default"


def test_piper_voice_comes_from_the_environment_when_config_is_silent(tmp_path, monkeypatch):
    frame = tmp_path / "f.jpg"
    frame.write_bytes(b"\xff\xd8\xff\xd9")
    cfg_path = tmp_path / "config.yml"
    cfg_path.write_text(
        "kaic_url: http://x\nkaic_api_key: y\n"
        f"cameras:\n  - {{camera_id: cam1, frame_url: 'file://{frame}', role: 'door'}}\n")
    monkeypatch.setenv("PIPER_VOICE", "en_GB-alan-medium")
    assert load_config(str(cfg_path)).piper_voice == "en_GB-alan-medium"
    monkeypatch.delenv("PIPER_VOICE")
    assert load_config(str(cfg_path)).piper_voice == ""


# ── 4. search_history fetches each photo once; face-ID only when asked who

class _Events:
    def __init__(self, rows):
        self.rows, self.fetches, self.last_pending = rows, [], None

    async def search(self, **kw):
        return self.rows

    async def evidence(self, event_id):
        self.fetches.append(event_id)
        return b"\xff\xd8crop%d" % event_id


class _Recognise:
    def __init__(self):
        self.calls = 0

    async def infer(self, *, frame_jpeg, extra=None, correlation_id=None):
        self.calls += 1
        return {"result": {"recognized": True, "name": "Priya"}}


def _visit(i):
    return SimpleNamespace(id=i, camera_id=7, label="person", score=0.9,
                           started_at="2026-09-28T14:02:00+05:30",
                           ended_at="2026-09-28T14:05:00+05:30",
                           stationary=False, plate_text=None, has_evidence=True)


def _tools(events, recognise):
    ctx = CameraContext(cameras=[CameraSpec(camera_id="cam1", frame_url="x", role="door",
                                            opennvr_camera_id=7)])
    return CameraTools(context=ctx, detection_client=None, caption_client=None,
                       recognition_client=recognise, events_client=events)


def test_did_anyone_come_fetches_each_photo_once_and_never_recognises():
    ev, rec = _Events([_visit(i) for i in range(1, 7)]), _Recognise()
    tools = _tools(ev, rec)
    out = asyncio.run(tools.search_history({"label": "person"}))
    assert "I remember 6 person visit" in out
    assert ev.fetches == [1, 2, 3], "the three shown photos, each once"
    assert rec.calls == 0, "'did anyone come' does not pay for face recognition"
    assert len(tools.last_evidence_frames) == 3
    assert "Recognised" not in out


def test_who_came_recognises_on_the_same_fetched_photos():
    ev, rec = _Events([_visit(i) for i in range(1, 7)]), _Recognise()
    tools = _tools(ev, rec)
    out = asyncio.run(tools.search_history({"label": "person", "identify_faces": True}))
    assert sorted(ev.fetches) == [1, 2, 3, 4], "four for face-ID, no photo fetched twice"
    assert rec.calls == 4
    assert "Recognised: Priya" in out
    assert len(tools.last_evidence_frames) == 3
