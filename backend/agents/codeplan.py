"""
CodePlan — neuro-symbolic repository mapper.
Scans workspace, builds file dependency graph, generates ordered execution plan.
"""
import ast
import os
from pathlib import Path
from langchain_google_genai import ChatGoogleGenerativeAI
from backend.orchestrator.state import VantageState


MODEL = "gemma4-26B-it"  # verify exact ID in Google AI Studio


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

    llm = ChatGoogleGenerativeAI(
        model=MODEL,
        google_api_key=state["google_api_key"],
        temperature=0.2,
    )

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

    response = llm.invoke(prompt)
    import json, re
    match = re.search(r"\{.*\}", response.content, re.DOTALL)
    parsed = json.loads(match.group()) if match else {"plan": [response.content], "risky_overwrites": []}

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
