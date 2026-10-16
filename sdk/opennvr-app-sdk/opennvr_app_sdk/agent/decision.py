# Copyright (c) 2026 OpenNVR
# SPDX-License-Identifier: Apache-2.0

"""What an AI step may answer, and what it answered.

A workflow author gives an AI step its options ("delivery", "cab",
"visitor") and, optionally, typed fields ("company": one of a list). The
step's answer is a :class:`Decision`: one of those options or
``"unsure"``, never anything else. :meth:`DecisionSpec.schema` is the
JSON schema the model's output is constrained to, and
:meth:`DecisionSpec.read` checks the output again, because a runtime may
honour the schema loosely.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .trace import TraceRow

UNSURE = "unsure"

#: Why a step decided "unsure" when the model did not choose it.
UNSURE_REASONS = (
    "below_floor",      # the confidence was under the spec's floor
    "invalid_output",   # the model's answer was not one the spec allows
    "llm_down",         # the model could not be reached or answered with an error
    "over_budget",      # the step's seconds ran out before an answer
    "error",            # anything else; the trace says what
)

_REASON_CHARS = 300


@dataclass(frozen=True)
class DecisionSpec:
    """The answers a step may give.

    ``options`` are the author's choices; ``"unsure"`` is always added and
    may not be listed. ``fields`` maps a field name to the values it may
    take. ``floor`` is the confidence below which a decision becomes
    ``"unsure"`` (``below_floor``).
    """

    options: tuple[str, ...]
    fields: dict[str, tuple[str, ...]] = field(default_factory=dict)
    floor: float = 0.75

    def __post_init__(self) -> None:
        options = tuple(str(o) for o in self.options)
        if not options:
            raise ValueError("a decision needs at least one option")
        if UNSURE in options:
            raise ValueError("'unsure' is always an option; do not list it")
        if len(set(options)) != len(options):
            raise ValueError("options must be distinct")
        fields = {}
        for name, values in self.fields.items():
            values = tuple(str(v) for v in values)
            if name in ("decision", "reason", "confidence") or not values:
                raise ValueError(f"field {name!r}: reserved name or no values")
            fields[str(name)] = values
        if not 0.0 <= self.floor <= 1.0:
            raise ValueError("floor must be between 0 and 1")
        object.__setattr__(self, "options", options)
        object.__setattr__(self, "fields", fields)

    def schema(self) -> dict[str, Any]:
        """The JSON schema the model's answer is constrained to.

        ``reason`` comes first. Constrained decoding writes the fields in
        schema order, so with ``decision`` first a model commits before it
        has said anything about what it saw; in a quick check, qwen3:1.7b
        then answered the first option ("delivery") for a cab and for a
        visitor alike. It made no difference on the Investigate cases
        (#649; the tool phase is where that model reasons). For Look it is
        not measured yet: that needs the Look cases."""
        props: dict[str, Any] = {"reason": {"type": "string"}}
        for name, values in self.fields.items():
            props[name] = {"type": "string", "enum": list(values)}
        props["decision"] = {"type": "string", "enum": [*self.options, UNSURE]}
        props["confidence"] = {"type": "number"}
        return {"type": "object", "properties": props, "required": list(props)}

    def read(self, data: Any) -> tuple[str, dict[str, str], str, float | None] | None:
        """``(decision, fields, reason, self_reported)`` from the model's
        output, or None when it is not an answer this spec allows. An
        ``"unsure"`` answer needs no fields."""
        if not isinstance(data, dict):
            return None
        decision = data.get("decision")
        if decision not in (*self.options, UNSURE):
            return None
        fields: dict[str, str] = {}
        if decision != UNSURE:
            for name, values in self.fields.items():
                if data.get(name) not in values:
                    return None
                fields[name] = data[name]
        conf = data.get("confidence")
        try:
            conf = None if conf is None else min(1.0, max(0.0, float(conf)))
        except (TypeError, ValueError):
            conf = None
        return decision, fields, str(data.get("reason") or "")[:_REASON_CHARS], conf


@dataclass
class Usage:
    """What a step spent."""

    model_calls: int = 0
    tool_calls: int = 0
    seconds: float = 0.0
    tokens_in: int = 0
    tokens_out: int = 0


@dataclass
class Decision:
    """An AI step's answer.

    ``decision`` is one of the spec's options or ``"unsure"``. When the
    step, not the model, made it unsure, ``unsure_reason`` says why (one of
    :data:`UNSURE_REASONS`) and ``proposed`` keeps what the model said, if
    anything. ``confidence`` is what the floor was applied to and
    ``confidence_source`` how it was computed; ``self_reported`` is the
    model's own number, kept for calibration and never gated on: on the
    Investigate eval it did not separate right answers from wrong ones
    (MODELS_AND_LATENCY.md, #649).
    """

    decision: str
    fields: dict[str, str] = field(default_factory=dict)
    reason: str = ""
    confidence: float = 0.0
    confidence_source: str = ""
    self_reported: float | None = None
    unsure_reason: str | None = None
    proposed: str | None = None
    evidence: list[str] = field(default_factory=list)   # ids of the tool rows that worked
    trace: list[TraceRow] = field(default_factory=list)
    usage: Usage = field(default_factory=Usage)

    @property
    def unsure(self) -> bool:
        return self.decision == UNSURE
