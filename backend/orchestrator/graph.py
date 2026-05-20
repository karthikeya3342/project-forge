"""
LangGraph orchestrator — central nervous system.
Routes: codeplan -> parsel -> swe_agent -> autocoderover -> [done|loop|hitl]
"""
from typing import Literal

from langgraph.graph import StateGraph, END
from langgraph.checkpoint.memory import MemorySaver

from backend.orchestrator.state import VantageState
from backend.agents.codeplan import run_codeplan
from backend.agents.parsel import run_parsel
from backend.agents.swe_agent import run_swe_agent
from backend.agents.autocoderover import run_autocoderover
from backend.broadcast import broadcast as _broadcast


MAX_STEPS = 50


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


def route_after_agent(state: VantageState) -> Literal["hitl", "autocoderover", "end"]:
    if state.get("step_count", 0) >= MAX_STEPS:
        _broadcast({"agent": "orchestrator", "state": "error", "message": "Max steps reached."})
        return "end"
    if state.get("hitl_required"):
        return "hitl"
    if state.get("status") == "error":
        _broadcast({"agent": "orchestrator", "state": "error", "message": state.get("last_error", "SWE-agent error.")})
        return "end"
    return "autocoderover"


def route_after_autocoderover(state: VantageState) -> Literal["hitl", "end"]:
    if state.get("hitl_required"):
        return "hitl"
    _broadcast({"type": "pipeline_done", "agent": "orchestrator", "state": "complete", "message": "Pipeline complete."})
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
        {"hitl": "hitl", "end": END},
    )

    # After HITL resolves (resume called externally), route based on approval
    graph.add_conditional_edges(
        "hitl",
        route_after_hitl_resume,
        {"swe_agent": "swe_agent", "end": END},
    )

    return graph.compile(checkpointer=checkpointer, interrupt_before=["hitl"])
