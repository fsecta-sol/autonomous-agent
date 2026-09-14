"""The chat model for a run — an OpenAI-compatible endpoint with per-agent creds.

Shared by the orchestrator graph and by sub-agents, which inherit the run's LLM.
"""

from langchain_openai import ChatOpenAI

from .models import RunRequest


def build_model(req: RunRequest) -> ChatOpenAI:
    return ChatOpenAI(
        model=req.llm.model,
        base_url=req.llm.baseUrl,
        api_key=req.llm.apiKey,
        streaming=True,
        temperature=0,
    )
