# Copyright (c) 2026 OpenNVR
# SPDX-License-Identifier: AGPL-3.0-or-later
"""The live-eval harness (tools/eval_harness.py): case loading, scoring and
aggregation are pure and tested here; the run loop is tested against a fake
agent and, end to end, against the real app with a scripted model. A run
against real models stays out of CI, like the latency harness."""
from __future__ import annotations

import importlib.util
import json
import pathlib

import pytest
from fastapi.testclient import TestClient

from camera_agent import AppConfig, CameraAgentRuntime, build_app
from context import CameraSpec

_TOOLS = pathlib.Path(__file__).resolve().parents[1] / "tools"
_spec = importlib.util.spec_from_file_location("eval_harness", _TOOLS / "eval_harness.py")
eh = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(eh)


def _step(name, by="model", **args):
    return {"step": name, "detail": "", "ms": 5, "by": by, "args": args}


def _trace(tier, *steps, source="llm"):
    return [{"step": "route", "detail": f"tier{tier}", "ms": 0}, *steps,
            {"step": "reply", "detail": source}]


# ── cases ──────────────────────────────────────────────────────────────

def test_the_shipped_case_file_loads():
    cases = eh.load_cases(_TOOLS / "eval_cases.yml")
    ids = [c["id"] for c in cases]
    for wanted in ("alarm-after-6pm", "monitor-crowd", "overnight-summary",
                   "what-is-person-wearing", "polite-close"):
        assert wanted in ids, "the five cases from AGENT_DESIGN.md"
    assert eh.uses_camera_placeholder(cases)
    filled = eh.fill_camera(cases, "front")
    assert not eh.uses_camera_placeholder(filled)


def test_a_json_case_file_needs_no_yaml(tmp_path):
    p = tmp_path / "c.json"
    p.write_text(json.dumps([{"id": "a", "ask": "hi", "expect": {"no_tool": True}}]))
    (case,) = eh.load_cases(p)
    assert case["turns"] == [{"ask": "hi", "camera": None, "expect": {"no_tool": True}}]


@pytest.mark.parametrize("raw, message", [
    ([], "non-empty"),
    ([{"ask": "hi", "expect": {"no_tool": True}}], "no id"),
    ([{"id": "a", "ask": "x", "expect": {"no_tool": True}}] * 2, "duplicate"),
    ([{"id": "a", "ask": "x"}], "nothing is scored"),
    ([{"id": "a", "ask": "x", "turns": [], "expect": {}}], "either"),
    ([{"id": "a", "ask": "x", "expect": {"tool": "t", "no_tool": True}}], "no_tool"),
    ([{"id": "a", "ask": "x", "expect": {"args": {"k": 1}}}], "needs a 'tool'"),
    ([{"id": "a", "ask": "x", "expect": {"state": {"widgets": {}}}}], "not one of"),
    ([{"id": "a", "ask": "x", "expect": {"tool": "t", "typo": 1}}], "unknown keys"),
])
def test_a_bad_case_file_is_refused_with_the_reason(raw, message):
    with pytest.raises(eh.CaseError, match=message):
        eh.normalise_cases(raw)


# ── scoring ────────────────────────────────────────────────────────────

def test_tier_comes_from_the_route_step():
    assert eh.tier_of(_trace(2)) == 2
    assert eh.tier_of([{"step": "route", "detail": "tier0 describe_camera"}]) == 0
    assert eh.tier_of([{"step": "reply", "detail": "roster"}]) is None


def test_match_value_rules():
    assert eh.match_value("Person", " person ")
    assert eh.match_value(["18:00", "6pm"], "6PM")
    assert eh.match_value("front", ["back", "front"])     # camera_ids
    assert not eh.match_value("person", None)
    assert eh.match_value(3, 3.0)
    assert not eh.match_value(True, 1)


def test_the_right_tool_chosen_by_the_model_passes_both_columns():
    s = eh.score_turn({"tool": "create_alarm", "args": {"target": "person"}},
                      _trace(2, _step("create_alarm", target="Person")), "ok", {})
    assert s["pass"] and s["model"] is True and s["tier"] == 2


def test_a_forced_grounding_passes_the_agent_but_not_the_model():
    s = eh.score_turn({"tool": "describe_camera"},
                      _trace(2, _step("describe_camera", by="forced", camera_id="c")),
                      "a person", {})
    assert s["pass"] is True
    assert s["model"] is False
    assert s["checks"]["tool"]["by"] == ["forced"]


def test_a_router_turn_has_no_model_score():
    s = eh.score_turn({"tool": "describe_camera"},
                      _trace(0, _step("describe_camera", by="router")), "x", {})
    assert s["pass"] is True and s["model"] is None


def test_wrong_arguments_fail_and_say_which_field():
    s = eh.score_turn({"tool": "create_alarm", "args": {"after": ["18:00", "6pm"]}},
                      _trace(2, _step("create_alarm", after="7pm")), "ok", {})
    assert not s["pass"]
    assert "after" in s["checks"]["tool"]["args"][0]


def test_state_is_checked_on_what_the_turn_created():
    expect = {"state": {"alarms": {"target": "person", "window": "after 18:00"}}}
    good = {"alarms": [{"id": 4, "target": "person", "window": "after 18:00"}]}
    bad = {"alarms": [{"id": 4, "target": "person", "window": "any time"}]}
    assert eh.score_turn(expect, _trace(2), "", good)["pass"]
    s = eh.score_turn(expect, _trace(2), "", bad)
    assert not s["pass"] and "window" in s["checks"]["state.alarms"]["fields"][0]
    assert not eh.score_turn(expect, _trace(2), "", {})["pass"]


def test_no_tool_fails_on_any_tool_and_on_anything_created():
    expect = {"no_tool": True}
    assert eh.score_turn(expect, _trace(2), "bye", {})["pass"]
    assert not eh.score_turn(expect, _trace(2, _step("describe_camera", by="forced")),
                             "bye", {})["pass"]
    assert not eh.score_turn(expect, _trace(2), "bye", {"tasks": [{"id": 1}]})["pass"]


def test_reply_checks():
    expect = {"no_tool": True, "reply_contains": ["bye", "welcome"], "reply_source": "llm"}
    assert eh.score_turn(expect, _trace(2), "You're welcome!", {})["pass"]
    assert not eh.score_turn(expect, _trace(2, source="none"), "You're welcome!", {})["pass"]
    assert not eh.score_turn(expect, _trace(2), "Hello", {})["pass"]


# ── aggregation ────────────────────────────────────────────────────────

def test_wilson_interval():
    lo, hi = eh.wilson(5, 5)
    assert hi == 1.0 and 0.5 < lo < 0.6
    assert eh.wilson(0, 0) == (0.0, 0.0)
    lo, hi = eh.wilson(2, 4)
    assert lo < 0.5 < hi


def test_aggregate_groups_by_case_and_tier():
    runs = [
        {"case": "a", "error": None, "pass": True, "model": True, "tier": 2, "latency_ms": 100},
        {"case": "a", "error": None, "pass": True, "model": False, "tier": 2, "latency_ms": 300},
        {"case": "a", "error": "boom", "leftovers": []},
        {"case": "b", "error": None, "pass": True, "model": None, "tier": 0, "latency_ms": 50},
    ]
    s = eh.aggregate(runs)
    a = s["cases"]["a"]
    assert (a["n"], a["errors"], a["pass"], a["model"], a["model_n"]) == (2, 1, 2, 1, 2)
    assert a["latency_ms_p50"] == 200
    assert s["cases"]["b"]["model"] is None
    assert s["tiers"]["tier2"]["pass"] == 2 and s["tiers"]["tier2"]["model"] == 1
    assert s["tiers"]["tier0"]["model_n"] == 0
    assert "case" in eh.format_report(s, {"repeat": 2})


# ── the run loop, against a fake agent ─────────────────────────────────

class _FakeAgent:
    """Answers like the agent's HTTP API: /ask creates an alarm and a task."""
    def __init__(self):
        self.alarms, self.tasks, self.calls, self.next_id = [], [], [], 1

    def __call__(self, method, path, body):
        self.calls.append((method, path))
        if (method, path) == ("POST", "/reset"):
            return 200, {"status": "ok"}
        if method == "GET":
            key = {"/alarms": "alarms", "/monitors": "monitors",
                   "/tasks": "tasks", "/reports": "schedules"}[path]
            return 200, {key: {"alarms": self.alarms, "tasks": self.tasks}.get(key, [])}
        if (method, path) == ("POST", "/ask"):
            self.alarms.append({"id": self.next_id, "target": "person",
                                "window": "after 18:00"})
            self.tasks.append({"id": self.next_id})
            self.next_id += 1
            return 200, {"reply": "Armed.", "latency_ms": 42, "trace": _trace(
                2, _step("create_alarm", target="person", after="6pm"))}
        if method == "DELETE" and path.startswith("/alarms/"):
            aid = int(path.rsplit("/", 1)[1])
            self.alarms = [a for a in self.alarms if a["id"] != aid]
            return 200, {"stopped": True}
        return 404, None


def test_run_case_scores_cleans_up_and_reports_leftovers():
    agent = _FakeAgent()
    case = eh.normalise_cases([{"id": "alarm", "ask": "alarm after 6pm", "expect": {
        "tool": "create_alarm", "args": {"after": ["18:00", "6pm"]},
        "state": {"alarms": {"window": "after 18:00"}}}}])[0]
    r = eh.run_case(agent, case)
    assert r["error"] is None and r["pass"] and r["model"] and r["tier"] == 2
    assert agent.alarms == [], "the alarm the case armed was deleted"
    assert r["leftovers"] == ["tasks#1"], "tasks have no delete route: reported"
    assert agent.calls[0] == ("POST", "/reset")


def _empty_collections(path):
    """What the agent's list routes answer when nothing exists."""
    key = {"/alarms": "alarms", "/monitors": "monitors",
           "/tasks": "tasks", "/reports": "schedules"}[path]
    return 200, {key: []}


def test_a_failing_ask_is_recorded_not_raised():
    def broken(method, path, body):
        if path == "/ask":
            return 502, {"error": "LLM at http://ollama timed out"}
        if method == "GET":
            return _empty_collections(path)
        return 200, {}
    case = eh.normalise_cases([{"id": "x", "ask": "hi", "expect": {"no_tool": True}}])[0]
    r = eh.run_case(broken, case)
    assert "timed out" in r["error"]


def test_main_refuses_without_throwaway(capsys):
    assert eh.main(["--camera", "c"]) == 2
    assert "--throwaway" in capsys.readouterr().err


# ── end to end, against the real app with a scripted model ─────────────

class _AlarmLLM:
    """Asks for create_alarm once, then confirms."""
    async def chat(self, *, messages=(), **kw):
        if not any(m.get("role") == "tool" for m in messages):
            return {"message": {"content": "", "tool_calls": [{
                "id": "t1", "type": "function", "function": {
                    "name": "create_alarm",
                    "arguments": {"name": "Evening person", "target": "person",
                                  "camera_id": "cam1", "after": "6pm"}}}]}}
        return {"message": {"content": "Done, the alarm is armed.", "tool_calls": []}}


def test_end_to_end_against_the_agent_app():
    cfg = AppConfig(kaic_url="http://k", kaic_api_key="key", system_prompt="t",
                    cameras=[CameraSpec("cam1", "http://x/f.jpg", "front")],
                    router_tier0=False, router_hints=False)
    rt = CameraAgentRuntime(cfg)
    rt.ollama = _AlarmLLM()
    client = TestClient(build_app(rt))

    def request(method, path, body):
        resp = client.request(method, path, json=body)
        return resp.status_code, resp.json()

    status, health = request("GET", "/health", None)
    assert health["router"] == {"tier0": False, "hints": False}
    assert "llm_temperature" in health

    case = eh.normalise_cases([{"id": "alarm-after-6pm",
                                "ask": "set an alarm if a person is seen after 6pm",
                                "expect": {
                                    "tool": "create_alarm",
                                    "args": {"target": "person", "after": ["18:00", "6pm"]},
                                    "state": {"alarms": {"target": "person",
                                                         "window": "after 18:00"}}}}])[0]
    r = eh.run_case(request, case)
    assert r["error"] is None, r
    assert r["pass"] and r["model"] is True and r["tier"] == 2, r["turns"][0]["score"]
    assert rt.alarms.list() == [], "the harness removed the alarm it armed"


# ── review round: cleanup never deletes what the case did not make ─────

class _Agent:
    """The list routes, /reset, /ask and DELETE, with switchable faults."""
    def __init__(self, *, alarms=None, fail_get=(), ask=None, deletes=True):
        self.alarms = {a["id"]: a for a in (alarms or [])}
        self.fail_get = list(fail_get)   # GET numbers (1-based) that answer 500
        self.ask = ask
        self.deletes = deletes
        self.gets = 0
        self.deleted = []

    def __call__(self, method, path, body):
        if (method, path) == ("POST", "/reset"):
            return 200, {"status": "ok"}
        if method == "GET":
            self.gets += 1
            if self.gets in self.fail_get:
                return 500, {"error": "boom"}
            if path == "/alarms":
                return 200, {"alarms": list(self.alarms.values())}
            return _empty_collections(path)
        if (method, path) == ("POST", "/ask"):
            return self.ask(self)
        if method == "DELETE" and path.startswith("/alarms/"):
            aid = int(path.rsplit("/", 1)[1])
            self.deleted.append(aid)
            if self.deletes:
                self.alarms.pop(aid, None)
            # 200 either way, like the real route outside the token's scope
            return 200, {"stopped": self.deletes, "already_gone": not self.deletes}
        return 404, None


_CASE = eh.normalise_cases([{"id": "c", "ask": "hi", "expect": {"no_tool": True}}])[0]


def _quiet_ask(agent):
    return 200, {"reply": "Hello.", "trace": _trace(2)}


def test_an_unreadable_snapshot_ends_the_case_and_deletes_nothing():
    """A transient 500 on the BEFORE snapshot used to read as "no alarms",
    so the operator's own alarm looked created by the case and was deleted."""
    agent = _Agent(alarms=[{"id": 1, "target": "operator's alarm"}],
                   fail_get=[1], ask=_quiet_ask)
    r = eh.run_case(agent, _CASE)
    assert "SnapshotError" in r["error"]
    assert agent.deleted == [] and 1 in agent.alarms


def test_a_failed_ask_still_cleans_up_what_the_turn_armed():
    def arm_then_fail(agent):
        agent.alarms[2] = {"id": 2, "target": "person"}
        return 502, {"error": "compose timed out"}
    agent = _Agent(alarms=[{"id": 1, "target": "operator's alarm"}], ask=arm_then_fail)
    r = eh.run_case(agent, _CASE)
    assert "timed out" in r["error"]
    assert agent.deleted == [2] and 2 not in agent.alarms
    assert 1 in agent.alarms, "only what the case created is touched"
    assert r["leftovers"] == []


def test_a_delete_that_removed_nothing_is_reported_left_behind():
    def arm(agent):
        agent.alarms[2] = {"id": 2, "target": "person"}
        return 200, {"reply": "Armed.", "trace": _trace(2)}
    agent = _Agent(ask=arm, deletes=False)
    r = eh.run_case(agent, _CASE)
    assert r["leftovers"] == ["alarms#2"]


def test_an_unreadable_after_state_is_reported_not_guessed():
    agent = _Agent(fail_get=[5], ask=_quiet_ask)    # GETs 1-4: before; 5: after
    r = eh.run_case(agent, _CASE)
    assert "SnapshotError" in r["error"]
    assert any(x.startswith("unknown:") for x in r["leftovers"])


# ── review round: scoring ──────────────────────────────────────────────

def test_a_tool_call_that_never_ran_is_not_the_right_tool_used():
    expect = {"tool": "search_footage"}
    marked = {"step": "search_footage", "detail": "not registered", "by": "model",
              "args": {}, "ok": False}
    older = {"step": "search_footage", "detail": "not registered", "by": "model", "args": {}}
    raised = {"step": "search_footage", "detail": "ERROR", "ms": 3, "by": "model", "args": {}}
    for step in (marked, older, raised):
        s = eh.score_turn(expect, _trace(2, step), "nothing found", {})
        assert not s["pass"] and s["model"] is False, step
        assert s["checks"]["tool"]["did_not_run"]
    # ...but it is still a tool choice: no_tool fails on it.
    s = eh.score_turn({"no_tool": True}, _trace(2, marked), "hi", {})
    assert not s["pass"]


def test_a_reused_identical_rule_is_credited():
    """create_alarm with an identical active alarm answers "already covers
    that" and creates nothing; the existing alarm satisfies the case."""
    expect = {"tool": "create_alarm", "state": {"alarms": {"target": "person"}}}
    trace = _trace(2, _step("create_alarm", target="person"))
    existing = {"alarms": {7: {"id": 7, "target": "person"}}}
    s = eh.score_turn(expect, trace, "Alarm #7 already covers that.", {}, existing)
    assert s["pass"] and s["checks"]["state.alarms"]["reused"] is True
    # Not when the create never ran.
    trace = _trace(2, {**_step("create_alarm", target="person"), "ok": False})
    assert not eh.score_turn(expect, trace, "", {}, existing)["pass"]


def test_a_roster_answer_has_no_model_score():
    s = eh.score_turn({"reply_source": "roster"},
                      [{"step": "reply", "detail": "roster"}], "2 cameras", {})
    assert s["pass"] and s["model"] is None


def test_camera_id_is_also_matched_in_camera_ids():
    expect = {"tool": "describe_camera", "args": {"camera_id": "front"}}
    step = _step("describe_camera", camera_ids=["front", "back"])
    assert eh.score_turn(expect, _trace(2, step), "", {})["pass"]


# ── review round: failures speak, they do not trace back ────────────────

def test_an_unreachable_agent_is_a_message_not_a_traceback(capsys):
    status, body = eh.http_requester("http://127.0.0.1:1", None, 2)("GET", "/health", None)
    assert status == 0 and "error" in body
    assert eh.main(["--throwaway", "--url", "http://127.0.0.1:1", "--camera", "c"]) == 2
    assert "is the agent up" in capsys.readouterr().err


def test_a_case_file_with_a_yaml_error_is_a_message(tmp_path, capsys):
    bad = tmp_path / "bad.yml"
    bad.write_text("- id: a\n  ask: [unclosed\n")
    assert eh.main(["--throwaway", "--cases", str(bad)]) == 2
    assert capsys.readouterr().err.startswith("cases:")


def test_every_traced_tool_step_says_whether_it_ran():
    cfg = AppConfig(kaic_url="http://k", kaic_api_key="key", system_prompt="t",
                    cameras=[CameraSpec("cam1", "http://x/f.jpg", "front")],
                    router_tier0=False, router_hints=False)
    rt = CameraAgentRuntime(cfg)
    rt.ollama = _AlarmLLM()
    body = TestClient(build_app(rt)).post("/ask", json={"text": "alarm after 6pm"}).json()
    (step,) = [t for t in body["trace"] if t["step"] == "create_alarm"]
    assert step["ok"] is True

