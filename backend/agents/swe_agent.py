"""
SWE-agent — the actuator.
Writes code into Docker sandbox and executes terminal commands.
ACI: Agent-Computer Interface pattern.

HITL policy (narrow — only truly destructive ops):
  - Dangerous shell commands: rm -rf, DROP TABLE, mkfs, etc.
  - File-level HITL removed (too noisy for normal dev tasks).
  - If user already approved a HITL for this run, skip all checks.
"""
import json
import re
import os
from pathlib import Path
from backend.orchestrator.state import VantageState
from backend.sandbox.docker_runner import DockerRunner
from backend.broadcast import broadcast as _broadcast_ws
from backend.agents.utils import call_llm


MODEL = "gemma-4-26b-a4b-it"

# Only truly destructive commands warrant HITL
DANGEROUS_CMD_PATTERNS = [
    "rm -rf",
    "rm -f",
    "rmdir /s",
    "rmdir /q",
    "DROP TABLE",
    "DROP DATABASE",
    "TRUNCATE TABLE",
    "DELETE FROM",
    "format c:",
    "mkfs",
    "dd if=",
    ":(){ :|:& };:",   # fork bomb
    "> /dev/sda",
    "shred ",
    "wipefs",
]


def _call_llm(prompt: str, api_key: str) -> str:
    def _on_chunk(text: str):
        _broadcast_ws({"type": "agent_token", "agent": "swe_agent", "text": text})
    return call_llm(MODEL, prompt, api_key, on_chunk=_on_chunk)


def is_dangerous_command(cmd: str) -> bool:
    cmd_lower = cmd.lower()
    return any(p.lower() in cmd_lower for p in DANGEROUS_CMD_PATTERNS)


def _build_tree(path: str, root: str) -> list:
    result = []
    try:
        for entry in sorted(os.scandir(path), key=lambda e: (not e.is_dir(), e.name)):
            rel = os.path.relpath(entry.path, root)
            node = {
                "path": rel.replace("\\", "/"),
                "name": entry.name,
                "type": "directory" if entry.is_dir() else "file",
            }
            if entry.is_dir():
                node["children"] = _build_tree(entry.path, root)
            result.append(node)
    except Exception:
        pass
    return result


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

    # ── HITL: dangerous commands only ─────────────────────────────────────
    # Skip checks entirely if the user already approved a HITL for this run.
    skip_hitl = state.get("hitl_approved") is True

    if not skip_hitl:
        dangerous_cmds = [
            cmd for cmd in result.get("commands", [])
            if is_dangerous_command(cmd)
        ]
        if dangerous_cmds:
            return {
                "hitl_required": True,
                "hitl_type": "dangerous_command",
                "hitl_description": (
                    f"SWE-agent wants to run destructive command(s): "
                    f"{'; '.join(dangerous_cmds)}"
                ),
                "status": "hitl_pause",
                "current_agent": "swe_agent",
                "step_count": 1,
                "last_telemetry": {
                    "agent": "swe_agent",
                    "state": "waiting_approval",
                    "message": f"HITL: destructive command(s) detected: {dangerous_cmds}",
                },
            }

    # ── Write files ────────────────────────────────────────────────────────
    work_dir = state.get("project_dir") or state["workspace_path"]
    runner = DockerRunner(work_dir)
    for file_spec in result.get("files", []):
        runner.write_file(file_spec["path"], file_spec["content"])
        _broadcast_ws({
            "type": "file_write",
            "path": file_spec["path"],
            "content": file_spec["content"],
        })

    _broadcast_ws({
        "type": "file_tree",
        "tree": _build_tree(work_dir, work_dir),
    })

    # ── Run commands ───────────────────────────────────────────────────────
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
        "hitl_approved": None,   # reset — don't carry approval across future HITLs
        "current_agent": "autocoderover",
        "step_count": 1,
        "last_telemetry": {
            "agent": "swe_agent",
            "state": "error" if last_error else "complete",
            "message": last_error or f"Wrote {len(code_changes)} file(s).",
        },
    }
