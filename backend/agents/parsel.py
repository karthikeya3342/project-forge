"""
Parsel — algorithmic decomposer.
Breaks complex tasks into isolated helper functions with base cases first.
"""
import json
import re
from google import genai
from backend.orchestrator.state import VantageState


MODEL = "gemma-4-31b-it"


def _call_llm(prompt: str, api_key: str) -> str:
    client = genai.Client(api_key=api_key)
    response = client.models.generate_content(
        model=MODEL,
        contents=prompt,
    )
    return response.text or ""


def run_parsel(state: VantageState) -> dict:
    plan_text = "\n".join(
        f"{i + 1}. {step}" for i, step in enumerate(state.get("execution_plan", []))
    )

    prompt = f"""You are Parsel, an algorithmic decomposer for an AI coding system.

User task: {state["user_prompt"]}

Execution plan from CodePlan:
{plan_text}

Decompose EACH plan step into the smallest possible helper functions.
Rules:
- Write base cases FIRST (leaf functions with no internal dependencies).
- Each task must be independently testable.
- No function should be longer than 20 lines.

Respond as a JSON array:
[
  {{
    "step_index": 0,
    "function_name": "helper_name",
    "signature": "def helper_name(args) -> return_type",
    "purpose": "one sentence",
    "base_case": true,
    "depends_on": []
  }},
  ...
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
