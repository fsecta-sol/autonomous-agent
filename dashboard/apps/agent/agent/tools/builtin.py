"""Small, dependency-free builtin tools."""

import json
from datetime import datetime, timezone

from langchain_core.tools import BaseTool, tool


def dumps(obj: object) -> str:
    """Serialize a tool result the way every tool returns — a JSON string."""
    return json.dumps(obj, ensure_ascii=False)


@tool
def get_current_time() -> str:
    """Return the current date and time in ISO 8601 (UTC)."""
    return dumps({"now": datetime.now(timezone.utc).isoformat()})


BUILTIN_TOOLS: dict[str, BaseTool] = {"get_current_time": get_current_time}
