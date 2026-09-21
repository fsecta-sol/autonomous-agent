"""The run payload the backend sends to /run, and the shapes it carries."""

from typing import Literal

from pydantic import BaseModel, Field


class LlmConfig(BaseModel):
    baseUrl: str
    apiKey: str
    model: str


class McpServerTarget(BaseModel):
    id: str
    name: str
    url: str
    apiKey: str | None = None


class ChatTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class ResumeDecision(BaseModel):
    """The operator's answer to a pending interrupt (tool approval)."""

    id: str | None = None
    decision: Literal["approve", "deny"]


class RunRequest(BaseModel):
    agentId: str = ""
    llm: LlmConfig
    system: str = "You are a helpful research assistant."
    history: list[ChatTurn] = Field(default_factory=list)
    tools: list[str] = Field(default_factory=list)
    mcp: list[McpServerTarget] = Field(default_factory=list)
    terminalMode: Literal["off", "sandbox", "unsandboxed"] = "off"
    allowUnsandboxed: bool = False
    # The run's frozen tool-execution policy for protected tools (ask/bypass),
    # resolved by the backend. "bypass" skips the interactive approval gate for
    # protected tools; every other safety boundary still applies.
    permissionMode: Literal["ask", "bypass"] = "ask"
    warnings: list[str] = Field(default_factory=list)
    # The chat session this run belongs to; becomes the LangGraph thread_id and
    # therefore the unit of persistence. Empty ⇒ an ephemeral, non-persistent run.
    sessionId: str = ""
    # When set, resume a run paused at an approval interrupt (same sessionId).
    resume: ResumeDecision | None = None
