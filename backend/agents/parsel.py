"""
Parsel — algorithmic decomposer.
Breaks complex tasks into isolated helper functions with base cases first.
"""
import json
import re
from langchain_google_genai import ChatGoogleGenerativeAI
from backend.orchestrator.state import VantageState


MODEL = "gemma4-31b-it"  # large model for complex decomposition — verify ID in Google AI Studio


def run_parsel(state: VantageState) -> dict:
    llm = ChatGoogleGenerativeAI(
        model=MODEL,
        google_api_key=state["google_api_key"],
        temperature=0.3,
    )

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

    response = llm.invoke(prompt)
    match = re.search(r"\[.*\]", response.content, re.DOTALL)
    tasks = json.loads(match.group()) if match else [{"step_index": 0, "function_name": "main_task", "purpose": response.content, "base_case": True, "depends_on": []}]

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
