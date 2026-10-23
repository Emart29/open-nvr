# Copyright (c) 2026 OpenNVR
# SPDX-License-Identifier: Apache-2.0

"""Workflow files (RFC #620): the public contract, ``workflow.v1``.

This first piece is the ``ai:`` step: checking one as the engine, the
builder and outside tools must all check it, and running it to an
outcome with the rows that explain it::

    from opennvr_app_sdk.workflows import AIStep, run_ai_step

    step = AIStep.from_dict(doc["then"][0]["ai"], skills=site_skills)
    result = await run_ai_step(step, llm, inputs=event, images=[jpeg])
    result.outcome        # one of the step's outcomes, or "unsure"
    result.actions        # that outcome's path, as written
    result.row()          # the workflow_run_steps row
    result.trace_rows()   # the workflow_tool_calls rows

Triggers, paths and actions are the engine's; see :mod:`.ai_step`.
"""
from __future__ import annotations

from .ai_step import (
    MAX_TOOLS,
    TOOL_EFFECTS,
    AIStep,
    AIStepError,
    StepResult,
    check_ai_step,
    resume_ai_step,
    run_ai_step,
)

__all__ = [
    "MAX_TOOLS",
    "TOOL_EFFECTS",
    "AIStep",
    "AIStepError",
    "StepResult",
    "check_ai_step",
    "resume_ai_step",
    "run_ai_step",
]
