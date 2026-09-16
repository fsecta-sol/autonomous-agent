"""Content extraction shared by the in-process fast tier and the browser worker.

Turn a scrapling Response into our payload shape: main-content Markdown for HTML,
extracted text for PDFs, decoded body otherwise. Kept dependency-light (no
langchain) so the browser worker subprocess can import it on its own.
"""

import io
import logging
from urllib.parse import urlparse

log = logging.getLogger("agent.tools.fetch_render")


def norm_headers(response) -> dict[str, str]:
    try:
        return {k.lower(): v for k, v in dict(response.headers).items()}
    except Exception:  # noqa: BLE001 — headers are best-effort; absent ones just mean no CF signal
        return {}


def render_html(response) -> str:
    """Main-content Markdown if we can, else the page's all-text."""
    try:
        body = response.markdown(main_content_only=True)
        if body and body.strip():
            return body
    except Exception as err:  # noqa: BLE001 — any conversion failure falls back to plain text
        log.debug("markdown extraction failed, falling back to text: %s", err)
    try:
        return str(response.get_all_text())
    except Exception:  # noqa: BLE001 — last-resort text; empty beats crashing the fetch
        return ""


def render_pdf(raw: bytes) -> tuple[str, str | None]:
    """Extract text from a PDF. Returns (text, error)."""
    try:
        from pypdf import PdfReader

        reader = PdfReader(io.BytesIO(raw))
        pages = []
        for page in reader.pages:
            try:
                pages.append(page.extract_text() or "")
            except Exception:  # noqa: BLE001 — one unreadable page must not sink the whole document
                pages.append("")
        return "\n\n".join(pages).strip(), None
    except Exception as err:  # noqa: BLE001 — reported to the caller as text, not raised
        return "", f"PDF extraction failed: {err}"


def render_response(response, url: str) -> dict:
    """Turn a scrapling Response into {contentType, text[, error]}."""
    headers = norm_headers(response)
    ctype = headers.get("content-type", "")
    raw = response.body if isinstance(response.body, (bytes, bytearray)) else b""
    path_pdf = urlparse(url).path.lower().endswith(".pdf")

    if "pdf" in ctype.lower() or path_pdf:
        text, err = render_pdf(bytes(raw))
        payload = {"contentType": ctype or "application/pdf", "text": text}
        if err:
            payload["error"] = err
        return payload

    if "html" in ctype.lower():
        text = render_html(response)
    else:
        text = raw.decode(response.encoding or "utf-8", errors="replace")

    return {"contentType": ctype, "text": text}
