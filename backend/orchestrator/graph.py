"""
LangGraph orchestrator — central nervous system.
Routes: codeplan -> parsel -> swe_agent -> autocoderover -> [done|loop|hitl]
"""
import asyncio
import json
from typing import Literal

from langgraph.graph import StateGraph, END
from langgraph.checkpoint.sqlite import SqliteSaver

from backend.orchestrator.state import VantageState
from backend.agents.codeplan import run_codeplan
from backend.agents.parsel import run_parsel
from backend.agents.swe_agent import run_swe_agent
from backend.agents.autocoderover import run_autocoderover


MAX_STEPS = 50

# Module-level WebSocket broadcast callback — set by main.py at startup
_broadcast_fn = None


def set_broadcast(fn):
    global _broadcast_fn
    _broadcast_fn = fn


def _broadcast(telemetry: dict):
    if _broadcast_fn:
        try:
            asyncio.get_event_loop().call_soon_threadsafe(
                asyncio.ensure_future, _broadcast_fn(json.dumps(telemetry))
            )
        except Exception:
            pass


def codeplan_node(state: VantageState) -> dict:
    _broadcast({"agent": "codeplan", "state": "working", "message": "Scanning workspace..."})
    result = run_codeplan(state)
    _broadcast(result.get("last_telemetry", {}))
    return result


def parsel_node(state: VantageState) -> dict:
    _broadcast({"agent": "parsel", "state": "working", "message": "Decomposing tasks..."})
    result = run_parsel(state)
    _broadcast(result.get("last_telemetry", {}))
    return result


def swe_agent_node(state: VantageState) -> dict:
    _broadcast({"agent": "swe_agent", "state": "working", "message": "Writing code..."})
    result = run_swe_agent(state)
    _broadcast(result.get("last_telemetry", {}))
    return result


def autocoderover_node(state: VantageState) -> dict:
    _broadcast({"agent": "autocoderover", "state": "working", "message": "Running AST audit..."})
    result = run_autocoderover(state)
    _broadcast(result.get("last_telemetry", {}))
    return result


def hitl_node(state: VantageState) -> dict:
    """Pause point — frontend renders Approve/Reject modal."""
    _broadcast({
        "agent": "orchestrator",
        "state": "waiting_approval",
        "message": state.get("hitl_description", "Human approval required."),
        "hitl_type": state.get("hitl_type"),
        "type": "hitl_required",
    })
    # LangGraph interrupt — execution halts here until resumed via /api/approve or /api/reject
    from langgraph.errors import NodeInterrupt
    raise NodeInterrupt(state.get("hitl_description", "HITL checkpoint"))


def route_after_agent(state: VantageState) -> Literal["hitl", "autocoderover", "codeplan", "end"]:
    if state.get("step_count", 0) >= MAX_STEPS:
        _broadcast({"agent": "orchestrator", "state": "error", "message": "Max steps reached."})
        return "end"
    if state.get("hitl_required"):
        return "hitl"
    if state.get("status") == "complete":
        _broadcast({"agent": "orchestrator", "state": "complete", "message": "Pipeline complete.", "type": "pipeline_done"})
        return "end"
    if state.get("status") == "error":
        return "end"
    return "autocoderover"


def route_after_autocoderover(state: VantageState) -> Literal["hitl", "codeplan", "end"]:
    if state.get("hitl_required"):
        return "hitl"
    if state.get("status") == "complete":
        return "end"
    # Loop back for next task if more steps remain
    return "end"


def route_after_hitl_resume(state: VantageState) -> Literal["swe_agent", "end"]:
    if state.get("hitl_approved"):
        return "swe_agent"
    return "end"


def build_graph(checkpointer=None) -> StateGraph:
    graph = StateGraph(VantageState)

    graph.add_node("codeplan", codeplan_node)
    graph.add_node("parsel", parsel_node)
    graph.add_node("swe_agent", swe_agent_node)
    graph.add_node("autocoderover", autocoderover_node)
    graph.add_node("hitl", hitl_node)

    graph.set_entry_point("codeplan")

    graph.add_edge("codeplan", "parsel")
    graph.add_edge("parsel", "swe_agent")

    graph.add_conditional_edges(
        "swe_agent",
        route_after_agent,
        {"hitl": "hitl", "autocoderover": "autocoderover", "end": END},
    )
    graph.add_conditional_edges(
        "autocoderover",
        route_after_autocoderover,
        {"hitl": "hitl", "codeplan": "codeplan", "end": END},
    )

    # After HITL resolves (resume called externally), route based on approval
    graph.add_conditional_edges(
        "hitl",
        route_after_hitl_resume,
        {"swe_agent": "swe_agent", "end": END},
    )

    return graph.compile(checkpointer=checkpointer, interrupt_before=["hitl"])
