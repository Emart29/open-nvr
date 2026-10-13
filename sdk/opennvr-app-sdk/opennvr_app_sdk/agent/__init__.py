# Copyright (c) 2026 OpenNVR
# SPDX-License-Identifier: Apache-2.0

"""The AI step library: what a workflow's AI step and an agent run on.

Phase 2 of the Agentic Workflows RFC (open-nvr discussion #620). This
first piece is the model clients — one interface over a local Ollama
and any OpenAI-compatible endpoint, with schema-constrained output::

    from opennvr_app_sdk.agent import OllamaChat

    async with OllamaChat("http://ollama:11434", model="qwen3:1.7b", think=False) as llm:
        result = await llm.chat(
            messages=[{"role": "user", "content": "Is this a delivery? ..."}],
            format={"type": "object",
                    "properties": {"decision": {"enum": ["delivery", "cab", "unknown"]}},
                    "required": ["decision"]},
        )
        decision = result.json()["decision"]

The loop, tools, decisions and limits land in later changes; see the
design note on #620.
"""
from __future__ import annotations

from .llm import (
    ChatResult,
    LLMClient,
    LLMError,
    LLMHTTPError,
    LLMOutputError,
    LLMTimeoutError,
    LLMUnreachableError,
    OllamaChat,
    OpenAIChat,
    ToolCall,
)

__all__ = [
    "ChatResult",
    "LLMClient",
    "LLMError",
    "LLMHTTPError",
    "LLMOutputError",
    "LLMTimeoutError",
    "LLMUnreachableError",
    "OllamaChat",
    "OpenAIChat",
    "ToolCall",
]
