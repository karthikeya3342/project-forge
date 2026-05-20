"""
SWE-agent — the actuator.
Writes code into Docker sandbox and executes terminal commands.
ACI: Agent-Computer Interface pattern.
"""
import json
import re
from pathlib import Path
from google import genai
from backend.orchestrator.state import VantageState
from backend.sandbox.docker_runner import DockerRunner
from backend.broadcast import broadcast as _broadcast_ws


MODEL = "gemma-4-31b-it"

HIGH_RISK_PATTERNS = [
    "setup.py", "requirements.txt", "pyproject.toml",
    "package.json", "tsconfig.json", "vite.config",
    "__init__.py", "settings.py", "config.py",
]


def _call_llm(prompt: str, api_key: str) -> str:
    client = genai.Client(api_key=api_key)
    response = client.models.generate_content(
        model=MODEL,
        contents=prompt,
    )
    return response.text or ""


def is_high_risk_overwrite(file_path: str, risky_list: list[str]) -> bool:
    name = Path(file_path).name
    return name in HIGH_RISK_PATTERNS or file_path in risky_list


def run_swe_agent(state: VantageState) -> dict:
    tasks_text = json.dumps(state.get("decomposed_tasks", []), indent=2)
    plan_text = "\n".join(state.get("execution_plan", []))

    prompt = f"""You are SWE-agent, an autonomous code writer operating inside a Docker sandbox.
Working directory: /workspace

User task: {state["user_prompt"]}

Execution plan:
{plan_text}

Decomposed tasks:
{tasks_text}

Write the actual code. For each file to create/modify respond with:
{{
  "files": [
    {{
      "path": "relative/path/from/workspace.py",
      "content": "full file content here",
      "action": "create|modify"
    }}
  ],
  "commands": ["pip install x", "python -m pytest tests/"]
}}

IMPORTANT: paths must be relative, no leading slash."""

    text = _call_llm(prompt, state["google_api_key"])
    match = re.search(r"\{.*\}", text, re.DOTALL)
    result = json.loads(match.group()) if match else {"files": [], "commands": []}

    runner = DockerRunner(state["workspace_path"])
    risky_list = list(state.get("file_dependency_map", {}).keys())

    risky_files = [
        f["path"] for f in result.get("files", [])
        if is_high_risk_overwrite(f["path"], risky_list)
    ]

    if risky_files:
        return {
            "hitl_required": True,
            "hitl_type": "file_overwrite",
            "hitl_description": f"SWE-agent wants to overwrite critical files: {', '.join(risky_files)}",
            "status": "hitl_pause",
            "current_agent": "swe_agent",
            "step_count": 1,
            "last_telemetry": {
                "agent": "swe_agent",
                "state": "waiting_approval",
                "message": f"HITL: overwrite request for {risky_files}",
            },
        }

    for file_spec in result.get("files", []):
        runner.write_file(file_spec["path"], file_spec["content"])
        _broadcast_ws({"type": "file_write", "path": file_spec["path"], "content": file_spec["content"]})

    import os
    def _build_tree(path: str, root: str) -> list:
        result = []
        try:
            for entry in sorted(os.scandir(path), key=lambda e: (not e.is_dir(), e.name)):
                rel = os.path.relpath(entry.path, root)
                node = {"path": rel.replace("\\", "/"), "name": entry.name, "type": "directory" if entry.is_dir() else "file"}
                if entry.is_dir():
                    node["children"] = _build_tree(entry.path, root)
                result.append(node)
        except Exception:
            pass
        return result
    _broadcast_ws({"type": "file_tree", "tree": _build_tree(state["workspace_path"], state["workspace_path"])})

    last_output = ""
    last_error = None
    for cmd in result.get("commands", []):
        run_result = runner.run_command(cmd)
        last_output = run_result["output"]
        if not run_result["success"]:
            last_error = run_result["error"]
            break

    code_changes = result.get("files", [])

    return {
        "code_changes": code_changes,
        "last_command_output": last_output,
        "last_error": last_error,
        "hitl_required": False,
        "current_agent": "autocoderover",
        "step_count": 1,
        "last_telemetry": {
            "agent": "swe_agent",
            "state": "error" if last_error else "complete",
            "message": last_error or f"Wrote {len(code_changes)} file(s).",
        },
    }
