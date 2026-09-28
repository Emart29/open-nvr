"""router.py — decide simple camera questions before the LLM sees them.

Tier 0 fires only when every slot resolves and the question is one
question; anything with a side effect, or about WHO, goes to the model.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

import router

IST = timezone(timedelta(hours=5, minutes=30))
NOW = datetime(2026, 9, 28, 9, 30, 0, tzinfo=IST)
ALL = {"describe_camera", "detect_objects", "search_history", "recent_events",
       "create_monitor", "create_alarm", "stop_alarm"}
CAMS = ["cam1", "cam2"]


ROLES = {"cam1": "front door", "cam2": "back yard"}


def _t0(text, *, cameras=CAMS, advertised=ALL, preferred=None, roles=ROLES):
    return router.decide_tier0(text, cameras=cameras, advertised=advertised,
                               preferred=preferred, roles=roles, now=NOW)


# ── Tier 0: every slot resolves ───────────────────────────────────────

@pytest.mark.parametrize("q, tool", [
    ("what do you see on cam1", "describe_camera"),
    ("is anyone at camera 2", "detect_objects"),
    ("how many cars on cam1", "detect_objects"),
    ("what is the person on cam2 wearing", "describe_camera"),
    ("Is anyone on Camera 2", "detect_objects"),          # STT capitalisation is not a name
    ("is the front door clear", "describe_camera"),        # the roster's role names the camera
])
def test_a_live_question_naming_a_camera_routes_to_the_live_tool(q, tool):
    d = _t0(q)
    assert d is not None and d.routed, (q, d)
    assert d.tool == tool
    assert d.args["camera_id"] in ("cam1", "cam2")


def test_a_describe_question_keeps_its_question():
    d = _t0("what is the person on cam2 wearing")
    assert d.routed and d.args.get("question") == "what is the person on cam2 wearing"
    d = _t0("what do you see on cam1")
    assert d.routed and "question" not in d.args, "a generic look gets the default caption"


def test_a_number_that_is_not_a_camera_is_not_a_camera():
    d = _t0("is anyone there in the last 2 hours", preferred="cam1")
    assert d.routed and d.args["camera_id"] == "cam1", "'2 hours' is not cam2"
    d = _t0("did a car come by between 2 and 4pm")
    assert not d.routed and "ambiguous" in d.reason, "no camera named at all"


def test_a_past_question_with_a_window_routes_to_history_with_iso_bounds():
    d = _t0("did a car come by cam1 between 2pm and 4pm")
    assert d.routed and d.tool == "search_history"
    assert d.args["camera_id"] == "cam1" and d.args["label"] == "car"
    assert d.args["start_time"].startswith("2026-09-28T14:00:00")
    assert d.args["end_time"].startswith("2026-09-28T16:00:00")


def test_a_relative_window_and_an_attribute_ride_along():
    d = _t0("did you see a blue truck on camera 1 in the last 2 hours")
    assert d.routed and d.tool == "search_history"
    assert d.args["label"] == "truck" and d.args["attr"] == ["blue"]
    assert d.args["start_time"].startswith("2026-09-28T07:30:00")


def test_all_cameras_is_a_camera():
    d = _t0("is anyone on any camera")
    assert d.routed and d.args["camera_id"] == "all"
    h = _t0("did anyone come to any of the cameras today")
    assert h.routed and h.tool == "search_history" and "camera_id" not in h.args


def test_the_camera_the_ui_is_on_or_the_only_camera_counts_as_named():
    d = _t0("what do you see", preferred="cam2")
    assert d.routed and d.args["camera_id"] == "cam2"
    d = _t0("what do you see", cameras=["cam1"])
    assert d.routed and d.args["camera_id"] == "cam1"


# ── Tier 0 refuses ────────────────────────────────────────────────────

def test_two_cameras_and_no_name_is_a_guess_not_a_route():
    d = _t0("what do you see")
    assert d is not None and not d.routed and "ambiguous" in d.reason


@pytest.mark.parametrize("q", [
    "alarm me if someone is at cam1 after 10pm",
    "watch cam1 and tell me if a car shows up",
    "notify me when you see a person on cam2",
    "stop the alarm on cam1",
    "every morning summarize cam1",
    "let me know if anyone comes to cam1",
])
def test_side_effects_and_standing_requests_go_to_the_model(q):
    d = _t0(q)
    assert d is not None and not d.routed, q
    assert "side effect" in d.reason


def test_stop_by_is_history_not_a_side_effect():
    d = _t0("did anyone stop by camera 1 today")
    assert d.routed and d.tool == "search_history"


@pytest.mark.parametrize("q", [
    "any plates on camera 1 today",
    "take a snapshot of cam1",
    "show me a picture of cam2",
])
def test_questions_for_tools_the_picker_does_not_know_go_to_the_model(q):
    d = _t0(q)
    assert d is not None and not d.routed and "another tool" in d.reason, q


@pytest.mark.parametrize("q", [
    "who came to cam1 today",
    "was Priya at camera 1 this morning",
    "do you recognise the person on cam1",
])
def test_who_questions_go_to_the_model(q):
    d = _t0(q)
    assert d is not None and not d.routed and "who" in d.reason


def test_a_config_question_is_not_the_routers_business():
    assert _t0("how many cameras do you have") is None


def test_two_questions_or_a_story_go_to_the_model():
    d = _t0("what do you see on cam1? and is anyone on cam2?")
    assert not d.routed and "two questions" in d.reason
    long = "so yesterday my neighbour said that around noon there was a van and " \
           "then later a bike and I wonder whether cam1 caught any of that at all"
    assert not _t0(long).routed


def test_a_past_question_with_no_history_tool_is_not_sent_to_a_live_detector():
    d = _t0("did a car come by cam1 today", advertised={"describe_camera", "detect_objects"})
    assert d is not None and not d.routed and "history tool" in d.reason


# ── Tier 1: a lexical hint, never a call ──────────────────────────────

def test_a_rephrasing_gets_a_hint_for_the_tool_it_resembles():
    h = router.hint_tier1("did anybody come by earlier", advertised=ALL)
    assert h is not None and h.tier == 1 and h.hint == "search_history"
    h = router.hint_tier1("is anybody at the door", advertised=ALL)
    assert h is not None and h.hint == "detect_objects"


def test_short_exemplars_still_count():
    h = router.hint_tier1("is anyone there", advertised=ALL)
    assert h is not None and h.hint == "detect_objects"
    assert all(" " not in v for v in router._SYNONYMS.values()), "a synonym must be one token"
    assert all(k != v for k, v in router._SYNONYMS.items()), "no identity mappings"


def test_no_resemblance_or_a_tie_means_no_hint():
    assert router.hint_tier1("tell me a joke about penguins", advertised=ALL) is None
    assert router.hint_tier1("", advertised=ALL) is None
    assert router.hint_tier1("is anybody at the door", advertised={"create_alarm"}) is None


# ── the one call the turn makes ───────────────────────────────────────

def test_decide_prefers_tier0_then_hint_then_nothing():
    d = router.decide("what do you see on cam1", cameras=CAMS, advertised=ALL, now=NOW)
    assert d.tier == 0 and d.tool == "describe_camera"
    d = router.decide("is anybody at the door", cameras=CAMS, advertised=ALL, now=NOW)
    assert d.tier == 1 and d.hint == "detect_objects", "two cameras: a hint, not a call"
    d = router.decide("tell me a joke", cameras=CAMS, advertised=ALL, now=NOW)
    assert d.tier == 2
    d = router.decide("what do you see on cam1", cameras=CAMS, advertised=ALL, tier0=False,
                      hints=False, now=NOW)
    assert d.tier == 2 and "off" in d.reason


def test_the_compose_prompt_is_short_and_ends_with_the_clock():
    p = router.compose_prompt("I am the agent.", "Always answer in Hindi.", "- cam1: front door",
                              "The current date and time is X.")
    assert p.startswith("I am the agent.")
    assert "Always answer in Hindi." in p, "the operator's prompt applies to routed turns too"
    assert p.rstrip().endswith("The current date and time is X.")
    assert "tool" not in p.lower(), "no schemas, no routing guidance: the decision is made"
    assert len(p.split()) < 140, "a compose prompt re-prefills every turn; it must stay small"
