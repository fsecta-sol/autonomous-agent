"""The chat model for a run — an OpenAI-compatible endpoint with per-agent creds.

Shared by the orchestrator graph and by sub-agents, which inherit the run's LLM.
"""

from langchain_openai import ChatOpenAI

from .config import stream_chunk_timeout_s
from .models import RunRequest


def build_model(req: RunRequest) -> ChatOpenAI:
    return ChatOpenAI(
        model=req.llm.model,
        base_url=req.llm.baseUrl,
        api_key=req.llm.apiKey,
        streaming=True,
        temperature=0,
        # Off by default — a reasoning model can think past the 120s default
        # between content chunks; see stream_chunk_timeout_s().
        stream_chunk_timeout=stream_chunk_timeout_s(),
    )
