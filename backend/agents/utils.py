"""
Shared LLM utilities.
  - call_llm()               — retry + optional streaming (text-only)
  - call_llm_with_tools_turn() — one turn of function-calling conversation
"""
import time
from google import genai
from google.genai import types as _gt

MAX_RETRIES = 3
_RETRY_DELAYS = [2, 4, 8]  # seconds


def _is_retryable(exc: Exception) -> bool:
    msg = str(exc).upper()
    return any(t in msg for t in ("500", "503", "UNAVAILABLE", "INTERNAL", "RESOURCE_EXHAUSTED"))


# ── Text-only LLM call (used by codeplan, parsel, autocoderover) ───────────

def call_llm(model: str, prompt: str, api_key: str, on_chunk=None) -> str:
    """
    Call Gemma with automatic retry on 5xx errors.
    If on_chunk(text: str) provided, streams tokens through it.
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
            raise
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
    try:
        full = ""
        for chunk in client.models.generate_content_stream(model=model, contents=prompt):
            text = chunk.text or ""
            if text:
                full += text
                on_chunk(text)
        return full
    except AttributeError:
        response = client.models.generate_content(model=model, contents=prompt)
        text = response.text or ""
        if text:
            on_chunk(text)
        return text


# ── Function-calling LLM turn (used by SWE-Agent agentic loop) ─────────────

def call_llm_with_tools_turn(
    model: str,
    system: str,
    history: list,          # list of genai types.Content
    tool_declarations: list,  # list of types.FunctionDeclaration
    api_key: str,
) -> tuple:
    """
    One agentic turn with function-calling support.

    Returns (text: str, func_calls: list[dict], model_content: Content)
      text       — any plain-text the model emitted this turn
      func_calls — [{"name": str, "args": dict}, ...]
      model_content — the raw Content object; append to history before next turn
    """
    client = genai.Client(api_key=api_key)
    tool = _gt.Tool(function_declarations=tool_declarations)
    last_exc: Exception = RuntimeError("No attempts made")

    for attempt in range(MAX_RETRIES + 1):
        try:
            response = client.models.generate_content(
                model=model,
                contents=history,
                config=_gt.GenerateContentConfig(
                    system_instruction=system,
                    tools=[tool],
                ),
            )

            candidate = response.candidates[0]
            content = candidate.content

            text_parts: list[str] = []
            func_calls: list[dict] = []

            for part in content.parts:
                if hasattr(part, "text") and part.text:
                    text_parts.append(part.text)
                if hasattr(part, "function_call") and part.function_call:
                    fc = part.function_call
                    func_calls.append({
                        "name": fc.name,
                        "args": dict(fc.args) if fc.args else {},
                    })

            return "\n".join(text_parts), func_calls, content

        except Exception as exc:
            last_exc = exc
            if attempt < MAX_RETRIES and _is_retryable(exc):
                print(
                    f"[VANTAGE/tools] {type(exc).__name__} "
                    f"(attempt {attempt + 1}/{MAX_RETRIES}), retrying in {_RETRY_DELAYS[attempt]}s"
                )
                time.sleep(_RETRY_DELAYS[attempt])
            else:
                raise

    raise last_exc


def make_tool_response_content(results: list[tuple[str, str]]):
    """
    Build a Content object that carries one or more function responses.
    results — [(tool_name, result_text), ...]
    """
    parts = [
        _gt.Part(
            function_response=_gt.FunctionResponse(
                name=name,
                response={"result": result},
            )
        )
        for name, result in results
    ]
    return _gt.Content(role="user", parts=parts)
