# Copyright (c) 2026 OpenNVR
# Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0)
"""Route a camera question before the LLM sees it.

The question space is small: what is on a camera NOW, or what CAME BY in
some window. One camera or all, one class of thing, one time phrase.
Today every one of those goes to a 1.5B model with fifteen tool schemas
and a request to compute an ISO window from the clock — the ~4k-token
prompt and the 17 s "iter 1" of the field trace, for a decision a regex
makes in a microsecond. The agent already has the regexes: they run
AFTER the model fails to ground ("forced grounding"). This runs them
FIRST, when they are sure.

Three tiers::

    0  deterministic — every slot resolves (which camera, which tool,
       which label, which window): call the tool now, then ask the LLM
       only to SAY the answer (a ~200-token compose prompt, no tools)
    1  lexical hint — the utterance resembles one tool's phrasings but a
       slot is missing or ambiguous: the full prompt goes out UNCHANGED
       (so Ollama's prefix cache holds) with one short system message
       before the user turn naming the likely tool
    2  the full LLM turn, exactly as before

Tier 0 fires only when every slot resolves and the question is one
question. Anything with a side effect — arm an alarm, start a monitor,
schedule a report, stop something — never routes: those deserve the
model's confirmation behaviour. Anything about WHO (a name, "who came")
goes to the model too, which decides whether to pay for face matching.
Every routed turn logs its tier so the hit rate is visible in the logs
and the vocabulary can grow from real misses.

Why Tier 1 is lexical and not an embedding model: the hint only steers
the LLM, which still sees the whole prompt and can ignore it. A
sentence-embedding model would add ~150 MB (onnxruntime + tokenizer) to
the agent image for that. Token overlap against per-tool exemplars is
zero dependencies, deterministic, and testable; if it ever needs to be
smarter, this module is the one place to swap it.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger("camera-agent.router")

#: Requests with a side effect or a standing shape. Never Tier 0: the
#: model's confirmation ("I'll watch the driveway and tell you…") is part
#: of the product for these.
_SIDE_EFFECT_RE = re.compile(
    r"\b(notify|alert|alarm|siren|watch|keep\s+(an\s+)?eye|monitor|remind|"
    r"report|summar(y|ize|ise)|every\s+(morning|evening|hour|day|\d+)|"
    r"stop\b(?!\s+by)|cancel|disarm|arm|turn\s+(on|off)|mute|silence|schedule|"
    r"from\s+now\s+on|whenever|if\s+(you\s+)?(see|spot)|let\s+me\s+know|"
    r"tell\s+me\s+(when|if))\b",
    re.IGNORECASE,
)

#: WHO questions — the word, or a proper name. The model decides whether
#: to pay for face matching, and how to phrase a name it does not know.
_WHO_RE = re.compile(r"\b(who|whom|whose|recogni[sz]e|name)\b", re.IGNORECASE)
#: A capitalised word that is not the first word: "was Priya here".
#: Transcripts arrive lowercase except for sentence starts and names —
#: and, from some STT, "Camera"; those and the roster's words are not
#: names (see _looks_like_name).
_NAME_RE = re.compile(r"(?<=[a-z0-9,] )[A-Z][a-z]{2,}\b")
_NOT_NAMES = {"camera", "cameras", "cam", "please", "okay", "hey", "there", "what",
              "who", "how", "when", "where", "which", "yes", "the", "any", "some"}

#: Questions that belong to OTHER tools the picker below does not know
#: (recent_plates, camera_snapshot, search_footage, the apps): never
#: Tier 0 — the picker's catch-all would answer "any plates today" with
#: people, and a snapshot request with a caption.
_OTHER_TOOL_RE = re.compile(
    r"\b(plates?|number\s*plates?|licen[cs]e|registration|snapshot|screenshot|"
    r"photo|picture|image|clip|apps?)\b", re.IGNORECASE)

#: A live question the picker CAN answer: it sees, counts, or describes.
_LIVE_ASK_RE = re.compile(
    r"\b(see|look|looking|view|show|clear|empty|happening|going\s+on|anything|"
    r"anyone|anybody|someone|somebody|nobody|how\s+many|any|there)\b", re.IGNORECASE)
#: "What do you see" and its kin: a description with no specific question
#: in it, for which describe_camera's own default caption is the answer.
_GENERIC_SEE_RE = re.compile(
    r"^\s*(what|whats|what's)\s+(do\s+you\s+see|can\s+you\s+see|is\s+(happening|going\s+on)|"
    r"does\s+it\s+look\s+like)\b", re.IGNORECASE)

#: "all cameras" / "every camera" / "any camera".
_ALL_RE = re.compile(r"\b(all|every|each|any)\s+(of\s+the\s+)?(cameras?|cams?|feeds?)\b|"
                     r"\b(everywhere|anywhere)\b", re.IGNORECASE)

#: Above this the utterance is probably two questions, or a story.
_MAX_WORDS = 20


@dataclass
class Decision:
    tier: int
    tool: str | None = None
    args: dict[str, Any] = field(default_factory=dict)
    hint: str | None = None
    reason: str = ""

    @property
    def routed(self) -> bool:
        return self.tier == 0


# ── Tier 0 ────────────────────────────────────────────────────────

_NUMBER_WORDS = {"one": "1", "two": "2", "three": "3", "four": "4", "five": "5",
                 "six": "6", "seven": "7", "eight": "8", "nine": "9"}


def _names_camera(text: str, cameras: list[str],
                  roles: dict[str, str] | None = None) -> str | None:
    """The camera the utterance NAMES, or None. Narrower than
    ``_pick_camera`` on purpose: that one always answers (it falls back
    to the first camera) and takes any bare digit as a camera number —
    "in the last 2 hours" became cam2. A router acts only on an explicit
    reference: the id itself, "camera N" / "camera two", or the camera's
    role from the roster ("the front door")."""
    t = (text or "").lower()
    compact = t.replace("-", " ").replace(" ", "")
    for cam in cameras:
        if re.search(rf"(?<![a-z0-9]){re.escape(cam.lower())}(?![a-z0-9])", compact):
            return cam
    m = re.search(r"\b(?:camera|cam)\s*(\d+|one|two|three|four|five|six|seven|eight|nine)\b", t)
    if m:
        n = _NUMBER_WORDS.get(m.group(1), m.group(1))
        for cam in cameras:
            if cam.lower() in (f"cam{n}", f"camera{n}"):
                return cam
    for cam, role in (roles or {}).items():
        r = (role or "").strip().lower()
        if len(r) >= 3 and re.search(rf"\b{re.escape(r)}\b", t) and cam in cameras:
            return cam
    return None


def _looks_like_name(text: str, cameras: list[str], roles: dict[str, str] | None) -> bool:
    """A capitalised word mid-sentence that is not a camera word or one
    of the roster's own words — 'Priya', not 'Camera' or 'Door'."""
    roster_words = {w for cam in cameras for w in re.findall(r"[a-z]+", cam.lower())}
    for role in (roles or {}).values():
        roster_words.update(re.findall(r"[a-z]+", (role or "").lower()))
    for m in _NAME_RE.finditer(text or ""):
        w = m.group(0).lower()
        if w not in _NOT_NAMES and w not in roster_words:
            return True
    return False


def decide_tier0(text: str, *, cameras: list[str], advertised: set[str],
                 preferred: str | None = None, roles: dict[str, str] | None = None,
                 now=None) -> Decision | None:
    """A tool call the agent can make without asking the model, or None."""
    from camera_agent import (
        _DESCRIBE_RE,
        _DETECTION_RE,
        _is_config_question,
        _is_past_question,
        _looks_like_camera_question,
        _pick_forced_call,
    )

    t = (text or "").strip()
    words = re.findall(r"[A-Za-z']+", t)
    if not t or not cameras:
        return None
    if len(words) > _MAX_WORDS or t.count("?") > 1:
        return Decision(2, reason="too long or two questions")
    if _is_config_question(t):
        return None                                   # answered from the roster
    if _SIDE_EFFECT_RE.search(t):
        return Decision(2, reason="side effect or standing request")
    if _WHO_RE.search(t) or _looks_like_name(t, cameras, roles):
        return Decision(2, reason="asks who")
    if _OTHER_TOOL_RE.search(t):
        return Decision(2, reason="another tool's question")
    if not _looks_like_camera_question(t):
        return Decision(2, reason="not a camera question")
    past = _is_past_question(t)
    nouns = {m.lower() for m in _DETECTION_RE.findall(t)}
    if len(nouns - {"anyone", "anybody", "someone", "somebody", "nobody",
                    "people", "person", "count", "many"}) > 1:
        return Decision(2, reason="more than one thing asked about")
    # The picker below only knows how to see, count, describe and search
    # for a class of thing. A question that names none of those is for
    # the model, not for its catch-all.
    if past and not nouns:
        return Decision(2, reason="no object named")
    if not past and not (nouns or _DESCRIBE_RE.search(t) or _LIVE_ASK_RE.search(t)):
        return Decision(2, reason="no known ask")

    # Which camera. Named, or "all", or the one the UI is on, or the only
    # one there is. Two cameras and no name is a guess — not Tier 0.
    if _ALL_RE.search(t):
        cam = "all"
    else:
        cam = _names_camera(t, cameras, roles)
        if cam is None:
            if preferred and preferred in cameras:
                cam = preferred
            elif len(cameras) == 1:
                cam = cameras[0]
            else:
                return Decision(2, reason="camera ambiguous")

    tool, args = _pick_forced_call(t, cam, advertised, now=now)
    if past and tool not in ("search_history", "recent_events"):
        # No history tool to send it to; a live detector cannot answer
        # "did". The model will say so in its own words.
        return Decision(2, reason="history tool not advertised")
    if tool not in advertised:
        return Decision(2, reason=f"{tool} not advertised")
    if past and tool == "search_history" and cam == "all":
        args.pop("camera_id", None)                   # history over every camera
    if tool == "describe_camera" and _DESCRIBE_RE.search(t) and not _GENERIC_SEE_RE.search(t):
        # "what is the person wearing": the VLM answers THAT, not a
        # generic caption the compose model then has to guess from.
        args["question"] = t
    return Decision(0, tool=tool, args=args,
                    reason=f"{'past' if past else 'live'} question, camera {cam}")


# ── Tier 1 ────────────────────────────────────────────────────────

#: Phrasings per tool, for the lexical hint. Grow this from real misses
#: in the logs ("router: tier=2 reason=..."), not from imagination.
_EXEMPLARS: dict[str, tuple[str, ...]] = {
    "describe_camera": (
        "what do you see", "what is happening", "describe the scene",
        "what is going on", "what does it look like", "is anything there",
        "what is the person wearing", "what is he doing", "look at the camera",
    ),
    "detect_objects": (
        "is anyone there", "is anybody at the door", "how many people",
        "are there any cars", "is there a person", "count the people",
        "any vehicles", "is someone outside", "is the gate clear",
    ),
    "search_history": (
        "did anyone come", "did a car come by", "who came to the door",
        "was there anyone earlier", "has anybody been here", "which cars entered",
        "did you see a truck today", "any visitors this morning",
        "what happened last night", "show me the history",
    ),
    "recent_events": (
        "what happened recently", "anything in the last few minutes",
        "any recent events", "what just happened",
    ),
}

#: Function words only. "there", "any", "show", "camera" carry meaning
#: for a tool ("is anyone there", "show me the history") and stay.
_STOP = {"the", "a", "an", "is", "are", "was", "were", "do", "does", "did",
         "you", "it", "to", "of", "on", "at", "in", "me", "my", "i",
         "can", "could", "please", "and", "or", "by", "up"}

#: Spellings that mean the same thing to a tool. Kept tiny on purpose;
#: every value must be ONE token or it can never match.
_SYNONYMS = {
    "anybody": "anyone", "somebody": "someone", "nobody": "noone",
    "cars": "car", "trucks": "truck", "vehicles": "vehicle", "people": "person",
    "persons": "person", "came": "come", "arrived": "come", "arrive": "come",
    "entered": "come", "visited": "come", "visitors": "visitor", "seen": "see",
    "saw": "see", "happening": "happen", "happened": "happen", "recently": "recent",
    "morning": "today", "tonight": "today", "afternoon": "today",
}


def _tokens(s: str) -> set[str]:
    return {_SYNONYMS.get(w, w) for w in re.findall(r"[a-z']+", (s or "").lower())
            if w not in _STOP}


def hint_tier1(text: str, *, advertised: set[str], threshold: float = 0.6,
               margin: float = 0.15) -> Decision | None:
    """The tool the utterance most resembles, when it clearly resembles
    one: the largest share of an exemplar's content words that the
    utterance contains (synonyms folded), over that tool's exemplars."""
    q = _tokens(text)
    if not q:
        return None
    scores: list[tuple[float, str]] = []
    for tool, phrases in _EXEMPLARS.items():
        if tool not in advertised:
            continue
        best = 0.0
        for ph in phrases:
            p = _tokens(ph)
            if len(p) < 2:
                continue
            best = max(best, len(q & p) / len(p))
        scores.append((best, tool))
    if not scores:
        return None
    scores.sort(reverse=True)
    top, tool = scores[0]
    runner = scores[1][0] if len(scores) > 1 else 0.0
    if top < threshold or top - runner < margin:
        return None
    return Decision(1, hint=tool, reason=f"resembles {tool} ({top:.2f})")


# ── the one call the turn makes ───────────────────────────────────

def decide(text: str, *, cameras: list[str], advertised: set[str],
           preferred: str | None = None, roles: dict[str, str] | None = None,
           tier0: bool = True, hints: bool = True, now=None) -> Decision:
    d = decide_tier0(text, cameras=cameras, advertised=advertised,
                     preferred=preferred, roles=roles, now=now) if tier0 else None
    if d is not None and d.routed:
        logger.info("router: tier=0 tool=%s args=%s (%s)", d.tool, d.args, d.reason)
        return d
    why = d.reason if d is not None else ("tier0 off" if not tier0 else "not routable")
    if hints:
        h = hint_tier1(text, advertised=advertised)
        if h is not None:
            logger.info("router: tier=1 hint=%s (%s; tier0: %s)", h.hint, h.reason, why)
            return h
    logger.info("router: tier=2 (%s)", why)
    return Decision(2, reason=why)


def compose_prompt(base_identity: str, operator_prompt: str, roster: str,
                   clock_line: str) -> str:
    """The short system prompt for a Tier-0 compose call: say the answer,
    nothing else. No tools, no routing guidance, no tool schemas — the
    decision is already made. The operator's own system prompt stays
    (a persona, a language, a camera never to mention): a routed turn
    must not behave differently from an un-routed one. ~200 tokens plus
    that, so re-prefilling it costs well under a second on CPU."""
    operator = (operator_prompt or "").strip()
    return (
        f"{base_identity}\n\n"
        + (f"{operator}\n\n" if operator else "")
        + f"Cameras:\n{roster}\n\n"
        "Your replies are SPOKEN ALOUD. Refer to a camera by its location, "
        "never its raw id. Answer in 1-2 short, natural sentences a person "
        "would say out loud — no ids, colons, lists, or markdown. You will be "
        "given the question and what the camera system found; state what was "
        "found, directly, in the first person. If it found nothing, say so. "
        "Never invent details that are not in what was found.\n\n"
        f"{clock_line}"
    )
