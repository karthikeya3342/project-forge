"""
Shared LLM utility — retry on 500/503 + optional token streaming.
"""
import time
from google import genai

MAX_RETRIES = 3
_RETRY_DELAYS = [2, 4, 8]  # seconds


def _is_retryable(exc: Exception) -> bool:
    msg = str(exc).upper()
    return any(t in msg for t in ("500", "503", "UNAVAILABLE", "INTERNAL", "RESOURCE_EXHAUSTED"))


def call_llm(model: str, prompt: str, api_key: str, on_chunk=None) -> str:
    """
    Call Gemma with automatic retry on 5xx errors.
    If on_chunk(text: str) is provided, streams tokens through it and returns
    the full accumulated text. Falls back to non-streaming if SDK lacks support.
    """
    client = genai.Client(api_key=api_key)
    last_exc: Exception = RuntimeError("No attempts made")

    for attempt in range(MAX_RETRIES + 1):
        try:
            if on_chunk:
                return _stream(client, model, prompt, on_chunk)
            response = client.models.generate_content(model=model, contents=prompt)
            return response.text or ""
        except AttributeError:
            raise  # SDK API mismatch — don't retry
        except Exception as exc:
            last_exc = exc
            if attempt < MAX_RETRIES and _is_retryable(exc):
                delay = _RETRY_DELAYS[attempt]
                print(
                    f"[VANTAGE] LLM {type(exc).__name__} "
                    f"(attempt {attempt + 1}/{MAX_RETRIES}), retrying in {delay}s — {exc}"
                )
                time.sleep(delay)
            else:
                raise

    raise last_exc


def _stream(client, model: str, prompt: str, on_chunk) -> str:
    """Stream tokens; falls back to single-shot if SDK doesn't expose the method."""
    try:
        full = ""
        for chunk in client.models.generate_content_stream(model=model, contents=prompt):
            text = chunk.text or ""
            if text:
                full += text
                on_chunk(text)
        return full
    except AttributeError:
        # generate_content_stream not available — deliver whole response as one chunk
        response = client.models.generate_content(model=model, contents=prompt)
        text = response.text or ""
        if text:
            on_chunk(text)
        return text
