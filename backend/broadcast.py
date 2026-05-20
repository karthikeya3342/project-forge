"""
Central broadcast module — thread-safe WebSocket dispatch.
Must be imported and configured before any graph nodes run.
"""
import asyncio
import json
from typing import Callable, Optional

_broadcast_fn: Optional[Callable] = None
_broadcast_loop: Optional[asyncio.AbstractEventLoop] = None


def set_broadcast(fn: Callable, loop: asyncio.AbstractEventLoop) -> None:
    global _broadcast_fn, _broadcast_loop
    _broadcast_fn = fn
    _broadcast_loop = loop


def broadcast(telemetry: dict) -> None:
    """Thread-safe broadcast — works from sync nodes in thread pool."""
    if not _broadcast_fn or not _broadcast_loop:
        return
    try:
        msg = json.dumps(telemetry)
        if _broadcast_loop.is_running():
            asyncio.run_coroutine_threadsafe(_broadcast_fn(msg), _broadcast_loop)
        else:
            print(f"[VANTAGE WS] loop not running, dropping: {msg[:80]}")
    except Exception as e:
        print(f"[VANTAGE WS] broadcast error: {e}")
