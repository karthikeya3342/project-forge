"""
LangGraph orchestrator — central nervous system.

Flow:
  codeplan → plan_approval* → [parsel|swe_agent] → autocoderover → [done|hitl]

* plan_approval PAUSES graph (interrupt_before) so user can review and approve
  the execution plan before any code is written.

HITL note: graph compiled with interrupt_before=["plan_approval", "hitl"].
Broadcasts for both gates happen in the PRECEDING agent node.
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
PARSEL_THRESHOLD = 4  # Skip Parsel if plan has <= this many steps


# ── Helpers ────────────────────────────────────────────────────────────────

def _hitl_broadcast(result: dict, agent: str) -> None:
    _broadcast({
        "type": "hitl_required",
        "agent": agent,
        "state": "waiting_approval",
        "message": result.get("hitl_description", "Approval required."),
        "hitl_type": result.get("hitl_type", "unknown"),
    })


def _completion_broadcast(state: VantageState) -> None:
    code_changes = state.get("code_changes", [])
    files_created = [c["path"] for c in code_changes if c.get("action") == "create"]
    files_modified = [c["path"] for c in code_changes if c.get("action") == "modify"]

    summary_parts = []
    if files_created:
        summary_parts.append(f"Created: {', '.join(files_created)}")
    if files_modified:
        summary_parts.append(f"Modified: {', '.join(files_modified)}")
    summary = " | ".join(summary_parts) if summary_parts else "No file changes."

    _broadcast({
        "type": "pipeline_done",
        "agent": "orchestrator",
        "state": "complete",
        "message": f"Pipeline complete. {summary}",
        "summary": {
            "files_created": files_created,
            "files_modified": files_modified,
            "ast_passed": state.get("ast_report", {}).get("passed", True),
        },
    })


# ── Nodes ──────────────────────────────────────────────────────────────────

def codeplan_node(state: VantageState) -> dict:
    _broadcast({"agent": "codeplan", "state": "working", "message": "Scanning workspace..."})
    result = run_codeplan(state)
    _broadcast(result.get("last_telemetry", {}))

    # Broadcast plan_ready HERE — graph will pause BEFORE plan_approval_node runs.
    # This gives the frontend the plan data before the interrupt fires.
    plan = result.get("execution_plan", [])
    _broadcast({
        "type": "plan_ready",
        "agent": "codeplan",
        "plan": plan,
        "project_dir": result.get("project_dir", ""),
        "step_count": len(plan),
    })

    return result


def plan_approval_node(state: VantageState) -> dict:
    """
    Pass-through — real pause managed by interrupt_before=["plan_approval"].
    On resume the graph re-enters here; state already updated by /api/approve-plan.
    """
    if state.get("plan_approved") is False:
        _broadcast({
            "type": "pipeline_error",
            "agent": "orchestrator",
            "state": "error",
            "message": "Pipeline aborted — plan rejected by user.",
        })
    return {}


def parsel_node(state: VantageState) -> dict:
    _broadcast({"agent": "parsel", "state": "working", "message": "Decomposing tasks..."})
    result = run_parsel(state)
    _broadcast(result.get("last_telemetry", {}))
    return result


def swe_agent_node(state: VantageState) -> dict:
    _broadcast({"agent": "swe_agent", "state": "working", "message": "Writing code..."})
    result = run_swe_agent(state)
    if result.get("hitl_required"):
        _hitl_broadcast(result, "swe_agent")
    else:
        _broadcast(result.get("last_telemetry", {}))
    return result


def autocoderover_node(state: VantageState) -> dict:
    _broadcast({"agent": "autocoderover", "state": "working", "message": "Running AST audit..."})
    result = run_autocoderover(state)
    if result.get("hitl_required"):
        _hitl_broadcast(result, "autocoderover")
    else:
        _broadcast(result.get("last_telemetry", {}))
    return result


def hitl_node(state: VantageState) -> dict:
    """Pass-through for HITL pause. Real gate is interrupt_before."""
    return {}


# ── Routing ────────────────────────────────────────────────────────────────

def route_after_plan_approval(state: VantageState) -> Literal["parsel", "swe_agent", "end"]:
    """User approved plan. Decide whether to decompose (Parsel) or go straight to SWE."""
    if state.get("plan_approved") is False:
        return "end"

    plan = state.get("execution_plan", [])
    if len(plan) <= PARSEL_THRESHOLD:
        _broadcast({
            "agent": "parsel",
            "state": "complete",
            "message": f"Skipped — plan is simple ({len(plan)} steps).",
        })
        return "swe_agent"
    return "parsel"


def route_after_agent(state: VantageState) -> Literal["hitl", "autocoderover", "end"]:
    if state.get("step_count", 0) >= MAX_STEPS:
        _broadcast({"agent": "orchestrator", "state": "error", "message": "Max steps reached."})
        return "end"
    if state.get("hitl_required"):
        return "hitl"
    if state.get("status") == "error":
        _broadcast({
            "type": "pipeline_error",
            "agent": "orchestrator",
            "state": "error",
            "message": state.get("last_error", "SWE-agent error."),
        })
        return "end"
    return "autocoderover"


def route_after_autocoderover(state: VantageState) -> Literal["hitl", "end"]:
    if state.get("hitl_required"):
        return "hitl"
    _completion_broadcast(state)
    return "end"


def route_after_hitl_resume(state: VantageState) -> Literal["swe_agent", "end"]:
    if not state.get("hitl_approved"):
        _broadcast({
            "type": "pipeline_error",
            "agent": "orchestrator",
            "state": "error",
            "message": "Pipeline aborted — HITL rejected by user.",
        })
        return "end"

    hitl_type = state.get("hitl_type", "unknown")
    if hitl_type == "vulnerability_found":
        _completion_broadcast(state)
        return "end"

    return "swe_agent"


# ── Graph ──────────────────────────────────────────────────────────────────

def build_graph(checkpointer=None) -> StateGraph:
    graph = StateGraph(VantageState)

    graph.add_node("codeplan", codeplan_node)
    graph.add_node("plan_approval", plan_approval_node)
    graph.add_node("parsel", parsel_node)
    graph.add_node("swe_agent", swe_agent_node)
    graph.add_node("autocoderover", autocoderover_node)
    graph.add_node("hitl", hitl_node)

    graph.set_entry_point("codeplan")

    # codeplan always flows to plan_approval (graph pauses here for user review)
    graph.add_edge("codeplan", "plan_approval")

    # After approval: smart routing
    graph.add_conditional_edges(
        "plan_approval",
        route_after_plan_approval,
        {"parsel": "parsel", "swe_agent": "swe_agent", "end": END},
    )
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
    graph.add_conditional_edges(
        "hitl",
        route_after_hitl_resume,
        {"swe_agent": "swe_agent", "end": END},
    )

    return graph.compile(
        checkpointer=checkpointer,
        interrupt_before=["plan_approval", "hitl"],
    )
