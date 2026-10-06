# Copyright (c) 2026 OpenNVR
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Per-turn pipeline trace: every LLM iteration and tool call a turn runs is
recorded in order with latency, so the UI can show the flow (llm →
describe_camera → llm) and a degraded describe names its fallback path."""
from __future__ import annotations

import asyncio

import camera_agent as ca
from camera_agent import AppConfig, CameraAgentRuntime
from context import CameraSpec


class _ScriptedLLM:
    """A call that has not seen a tool result asks for a tool; a call that
    has (the router's compose call, or iteration two) composes the answer."""
    def __init__(self):
        self.calls = 0

    async def chat(self, *, messages=(), **kw):
        self.calls += 1
        if not any(m.get("role") == "tool" for m in messages):
            return {"message": {"content": "", "tool_calls": [{
                "id": "t1", "type": "function",
                "function": {"name": "describe_camera",
                             "arguments": {"camera_id": "cam1"}}}]}}
        return {"message": {"content": "There is a person at the door.",
                            "tool_calls": []}}


def _runtime(*, router: bool = True):
    cfg = AppConfig(kaic_url="http://k", kaic_api_key="key", system_prompt="t",
                    cameras=[CameraSpec("cam1", "http://x/f.jpg", "front")],
                    router_tier0=router, router_hints=router)
    rt = CameraAgentRuntime(cfg)
    rt.ollama = _ScriptedLLM()

    class _Src:
        def fetch(self):
            return b"\xff\xd8jpeg"
    rt.context.register_frame_source("cam1", _Src())

    class _Caption:
        async def infer(self, **kw):
            return {"result": {"caption": "a person at the door"}}
    rt.tools._caption = _Caption()
    return rt


def test_trace_records_llm_and_tool_steps_in_order():
    """With the router off: the classic llm → tool → llm shape."""
    rt = _runtime(router=False)
    reply = asyncio.run(ca._run_conversation_turn(rt, [], "what do you see on cam1?"))
    assert "person" in reply.lower()
    steps = [(t["step"], t["detail"]) for t in rt.last_turn_trace]
    assert steps[0] == ("route", "tier2")
    assert steps[1][0] == "llm"
    assert steps[2][0] == "describe_camera"
    assert "cam1" in steps[2][1] and "vlm" in steps[2][1]   # names the path
    assert steps[3][0] == "llm"
    assert all(t["ms"] >= 0 for t in rt.last_turn_trace if t["step"] != "reply")


def test_trace_records_a_routed_turn_as_route_tool_compose():
    """The router decided: no tool-calling iteration, one compose call."""
    rt = _runtime()
    reply = asyncio.run(ca._run_conversation_turn(rt, [], "what do you see on cam1?"))
    assert "person" in reply.lower()
    steps = [(t["step"], t["detail"]) for t in rt.last_turn_trace]
    assert steps[0] == ("route", "tier0 describe_camera")
    assert steps[1][0] == "describe_camera"
    assert steps[2] == ("compose", "tier0"), "its own step: not in the llm median"
    assert rt.ollama.calls == 1, "the whole tool-calling iteration was skipped"


def test_trace_marks_detector_fallback_when_vision_down():
    rt = _runtime()

    class _Raising:
        async def infer(self, **kw):
            raise RuntimeError("403 Forbidden")

    class _Detect:
        async def infer(self, **kw):
            return {"result": {"detections": [{"label": "person", "score": 0.9}]}}
    rt.tools._caption = _Raising()
    rt.tools._detect = _Detect()
    asyncio.run(ca._run_conversation_turn(rt, [], "what do you see on cam1?"))
    tool_steps = [t for t in rt.last_turn_trace if t["step"] == "describe_camera"]
    assert tool_steps and "detector-fallback" in tool_steps[0]["detail"]


def test_trace_resets_each_turn():
    rt = _runtime()
    asyncio.run(ca._run_conversation_turn(rt, [], "what do you see on cam1?"))
    first = list(rt.last_turn_trace)
    rt.ollama = _ScriptedLLM()               # fresh script for turn 2
    asyncio.run(ca._run_conversation_turn(rt, [], "what do you see on cam1?"))
    assert rt.last_turn_trace is not first   # new list, not accumulation


# ── Provenance: who chose each tool, with what arguments, and where the
# reply came from (Discussion #607 — groundwork for the live-eval harness).

class _NoToolLLM:
    """Answers straight from the prompt, never calling a tool."""
    def __init__(self, content="I see a dog on cam1."):
        self.content = content

    async def chat(self, *, messages=(), **kw):
        return {"message": {"content": self.content, "tool_calls": []}}


class _OneCallLLM:
    """Asks for one scripted tool call, then answers with ``after``."""
    def __init__(self, name, arguments, after="Done."):
        self.name, self.arguments, self.after = name, arguments, after

    async def chat(self, *, messages=(), **kw):
        if not any(m.get("role") == "tool" for m in messages):
            return {"message": {"content": "", "tool_calls": [{
                "id": "t1", "type": "function",
                "function": {"name": self.name, "arguments": self.arguments}}]}}
        return {"message": {"content": self.after, "tool_calls": []}}


def _tool_steps(rt):
    return [t for t in rt.last_turn_trace if t["step"] not in ("route", "llm", "compose", "reply")]


def test_a_model_chosen_tool_carries_its_arguments_and_by_model():
    rt = _runtime(router=False)
    asyncio.run(ca._run_conversation_turn(rt, [], "what do you see on cam1?"))
    (step,) = _tool_steps(rt)
    assert step["by"] == "model"
    assert step["args"] == {"camera_id": "cam1"}


def test_a_router_chosen_tool_is_marked_by_router():
    rt = _runtime()
    asyncio.run(ca._run_conversation_turn(rt, [], "what do you see on cam1?"))
    (step,) = _tool_steps(rt)
    assert step["by"] == "router"
    assert step["args"].get("camera_id") == "cam1"


def test_a_forced_grounding_is_marked_forced_not_model():
    """The model skipped the tool; the agent picked one. An eval must not
    credit the model with that call."""
    rt = _runtime(router=False)
    rt.ollama = _NoToolLLM()
    asyncio.run(ca._run_conversation_turn(rt, [], "what do you see on cam1?"))
    steps = _tool_steps(rt)
    assert steps and steps[0]["by"] == "forced"
    assert "forced" in steps[0]["detail"]
    assert steps[0]["args"].get("camera_id") == "cam1"


def test_args_are_recorded_as_asked_not_as_the_handler_left_them():
    rt = _runtime(router=False)

    async def _mutating(args):
        args["after"] = "18:00"      # what a normalising handler does
        return "ok"
    rt.tool_handlers["create_alarm"] = _mutating
    rt.ollama = _OneCallLLM("create_alarm", '{"target": "person", "after": "6pm"}')
    asyncio.run(ca._run_conversation_turn(rt, [], "set an alarm if a person is seen after 6pm"))
    (step,) = [t for t in rt.last_turn_trace if t["step"] == "create_alarm"]
    assert step["args"] == {"target": "person", "after": "6pm"}
    assert step["by"] == "model"


def test_the_last_step_names_the_reply_source_and_has_no_ms():
    rt = _runtime(router=False)
    asyncio.run(ca._run_conversation_turn(rt, [], "what do you see on cam1?"))
    last = rt.last_turn_trace[-1]
    assert last == {"step": "reply", "detail": "llm"}


def test_an_empty_compose_is_traced_as_tool_fallback():
    rt = _runtime(router=False)
    rt.ollama = _OneCallLLM("describe_camera", {"camera_id": "cam1"}, after="")
    reply = asyncio.run(ca._run_conversation_turn(rt, [], "what do you see on cam1?"))
    assert "person" in reply.lower()
    assert rt.last_turn_trace[-1] == {"step": "reply", "detail": "tool_fallback"}


def test_a_roster_question_replaces_the_previous_turns_trace():
    rt = _runtime()
    asyncio.run(ca._run_conversation_turn(rt, [], "what do you see on cam1?"))
    asyncio.run(ca._run_conversation_turn(rt, [], "how many cameras are configured?"))
    assert rt.last_turn_trace == [{"step": "reply", "detail": "roster"}]


def test_malformed_and_unregistered_calls_are_traced_not_dropped():
    rt = _runtime(router=False)
    rt.last_turn_trace = []
    name, result = asyncio.run(ca._invoke_tool(rt, {"function": {
        "name": "describe_camera", "arguments": "{not json"}}))
    assert result.startswith("ERROR")
    name, result = asyncio.run(ca._invoke_tool(rt, {"function": {
        "name": "no_such_tool", "arguments": {"camera_id": "cam1"}}}))
    assert result.startswith("ERROR")
    name, result = asyncio.run(ca._invoke_tool(rt, {"function": {
        "name": "describe_camera", "arguments": "[1, 2]"}}))
    assert result.startswith("ERROR")
    bad, missing, not_object = rt.last_turn_trace
    assert bad["step"] == "describe_camera" and "malformed" in bad["detail"]
    assert bad["raw_args"] == "{not json" and bad["args"] == {}
    assert missing["step"] == "no_such_tool" and "not registered" in missing["detail"]
    assert missing["args"] == {"camera_id": "cam1"}
    assert "malformed" in not_object["detail"]
    assert all(t["by"] == "model" for t in rt.last_turn_trace)
    # Nothing ran, so no latency to feed the thinking-aloud medians.
    assert not any("ms" in t for t in rt.last_turn_trace)
