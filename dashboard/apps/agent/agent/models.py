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


class RunRequest(BaseModel):
    agentId: str = ""
    llm: LlmConfig
    system: str = "You are a helpful research assistant."
    history: list[ChatTurn] = Field(default_factory=list)
    tools: list[str] = Field(default_factory=list)
    mcp: list[McpServerTarget] = Field(default_factory=list)
    terminalMode: Literal["off", "sandbox", "unsandboxed"] = "off"
    allowUnsandboxed: bool = False
    warnings: list[str] = Field(default_factory=list)
