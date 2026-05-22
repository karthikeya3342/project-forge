"""
Parsel — algorithmic decomposer.
Breaks complex tasks into isolated helper functions with base cases first.
"""
import json
import re
from backend.orchestrator.state import VantageState
from backend.agents.utils import call_llm
from backend.broadcast import broadcast as _broadcast_ws


MODEL = "gemma-4-26b-a4b-it"


def _call_llm(prompt: str, api_key: str) -> str:
    def _on_chunk(text: str):
        _broadcast_ws({"type": "agent_token", "agent": "parsel", "text": text})
    return call_llm(MODEL, prompt, api_key, on_chunk=_on_chunk)


def run_parsel(state: VantageState) -> dict:
    plan_text = "\n".join(
        f"{i + 1}. {step}" for i, step in enumerate(state.get("execution_plan", []))
    )

    prompt = f"""You are Parsel, a task decomposer for an AI coding system.

User task: {state["user_prompt"]}

Execution plan from CodePlan:
{plan_text}

Break the plan into implementation tasks for the SWE-Agent. Each task = one logical unit of work (usually one file or one major feature).

RULES:
- Generate 3-8 tasks MAX. Fewer is better. Combine related functions into one task.
- Each task describes WHAT to build, not individual functions.
- Base cases first (utilities, data models), then features, then integration/tests.
- Do NOT create a separate task for every tiny function. Group by file or feature.

Respond as a JSON array:
[
  {{
    "step_index": 0,
    "function_name": "core_data_layer",
    "signature": "File: src/models.py",
    "purpose": "Create data models and persistence logic",
    "base_case": true,
    "depends_on": []
  }}
]"""

    text = _call_llm(prompt, state["google_api_key"])
    match = re.search(r"\[.*\]", text, re.DOTALL)
    tasks = json.loads(match.group()) if match else [{"step_index": 0, "function_name": "main_task", "purpose": text, "base_case": True, "depends_on": []}]

    return {
        "decomposed_tasks": tasks,
        "current_agent": "swe_agent",
        "step_count": 1,
        "last_telemetry": {
            "agent": "parsel",
            "state": "complete",
            "message": f"Decomposed into {len(tasks)} helper functions.",
        },
    }
