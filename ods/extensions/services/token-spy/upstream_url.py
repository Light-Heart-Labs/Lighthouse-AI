"""OpenAI-compatible upstream URL helpers."""

from urllib.parse import urlsplit


_API_BASE_SUFFIXES = ("/v1", "/api/v1", "/engines/v1")


def openai_api_base_url(url: str) -> str:
    """Return a complete OpenAI-compatible API base without changing providers."""
    candidate = url.strip().rstrip("/")
    path = urlsplit(candidate).path.rstrip("/")
    if path.endswith(_API_BASE_SUFFIXES):
        return candidate
    return f"{candidate}/v1"
