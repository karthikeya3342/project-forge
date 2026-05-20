"""
CodePlan — neuro-symbolic repository mapper.
Scans workspace, builds file dependency graph, generates ordered execution plan.
"""
import ast
import json
import re
from pathlib import Path
from google import genai
from backend.orchestrator.state import VantageState
from backend.broadcast import broadcast as _broadcast_ws


MODEL = "gemma-4-26b-a4b-it"


def _call_llm(prompt: str, api_key: str) -> str:
    client = genai.Client(api_key=api_key)
    response = client.models.generate_content(
        model=MODEL,
        contents=prompt,
    )
    return response.text or ""


def build_dependency_map(workspace_path: str) -> dict:
    """Parse Python imports to build {file -> [imported_files]} map."""
    dep_map: dict[str, list[str]] = {}
    root = Path(workspace_path)

    for py_file in root.rglob("*.py"):
        rel = str(py_file.relative_to(root))
        deps = []
        try:
            tree = ast.parse(py_file.read_text(encoding="utf-8", errors="ignore"))
            for node in ast.walk(tree):
                if isinstance(node, (ast.Import, ast.ImportFrom)):
                    module = ""
                    if isinstance(node, ast.ImportFrom) and node.module:
                        module = node.module.replace(".", "/") + ".py"
                    elif isinstance(node, ast.Import):
                        for alias in node.names:
                            module = alias.name.replace(".", "/") + ".py"
                    if module:
                        candidate = root / module
                        if candidate.exists():
                            deps.append(str(Path(module)))
        except SyntaxError:
            pass
        dep_map[rel] = deps

    return dep_map


def run_codeplan(state: VantageState) -> dict:
    dep_map = build_dependency_map(state["workspace_path"])

    workspace_summary = "\n".join(
        f"{f}: depends on {deps}" for f, deps in dep_map.items()
    ) or "Empty workspace — no Python files found."

    prompt = f"""You are CodePlan, a repository mapper for an AI coding system.

User task: {state["user_prompt"]}

Workspace dependency map:
{workspace_summary}

Generate a numbered execution plan (max 10 steps) that:
1. Identifies which files need to be created or modified.
2. Orders them so dependencies are handled before dependents.
3. Flags any file that, if overwritten, would break other files.

Respond as a JSON object:
{{
  "plan": ["step 1 description", "step 2 description", ...],
  "risky_overwrites": ["file1.py", "file2.py"]
}}"""

    text = _call_llm(prompt, state["google_api_key"])
    match = re.search(r"\{.*\}", text, re.DOTALL)
    parsed = json.loads(match.group()) if match else {"plan": [text], "risky_overwrites": []}

    # Build file tree for frontend
    def _build_tree(path: str, root: str) -> list:
        import os
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

    _broadcast_ws({"type": "dependency_map", "map": dep_map})
    _broadcast_ws({"type": "file_tree", "tree": _build_tree(state["workspace_path"], state["workspace_path"])})

    return {
        "file_dependency_map": dep_map,
        "execution_plan": parsed.get("plan", []),
        "current_agent": "parsel",
        "step_count": 1,
        "last_telemetry": {
            "agent": "codeplan",
            "state": "complete",
            "message": f"Mapped {len(dep_map)} files. Plan has {len(parsed.get('plan', []))} steps.",
        },
    }
