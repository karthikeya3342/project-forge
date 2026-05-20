"""
CodePlan — neuro-symbolic repository mapper.
Scans workspace, builds file dependency graph, generates ordered execution plan.
"""
import ast
import json
import re
from pathlib import Path
from backend.orchestrator.state import VantageState
from backend.broadcast import broadcast as _broadcast_ws
from backend.agents.utils import call_llm


MODEL = "gemma-4-26b-a4b-it"


def _call_llm(prompt: str, api_key: str) -> str:
    def _on_chunk(text: str):
        _broadcast_ws({"type": "agent_token", "agent": "codeplan", "text": text})
    return call_llm(MODEL, prompt, api_key, on_chunk=_on_chunk)


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
    import re as _re

    def _read_workspace_context(workspace_path: str, max_files: int = 8, max_chars: int = 2000) -> str:
        import os
        root = Path(workspace_path)
        code_exts = {'.py', '.ts', '.tsx', '.js', '.jsx', '.cpp', '.c', '.java', '.go', '.rs', '.cs', '.rb', '.php'}
        entry_names = {'main', 'index', 'app', 'server', 'cli'}

        all_files = []
        for f in root.rglob('*'):
            if f.is_file() and f.suffix in code_exts:
                priority = 0 if f.stem.lower() in entry_names else 1
                all_files.append((priority, f.stat().st_mtime, f))

        all_files.sort(key=lambda x: (x[0], -x[1]))

        context_parts = []
        for _, _, f in all_files[:max_files]:
            try:
                content = f.read_text(encoding='utf-8', errors='ignore')[:max_chars]
                rel = f.relative_to(root)
                context_parts.append(f"### {rel}\n```\n{content}\n```")
            except Exception:
                pass

        return '\n\n'.join(context_parts) if context_parts else "No existing files."

    def _slugify(text: str) -> str:
        stop = {'write', 'a', 'an', 'the', 'to', 'for', 'in', 'create', 'make', 'build', 'implement', 'code', 'program', 'script', 'that', 'which', 'with', 'using', 'develop'}
        words = _re.findall(r'[a-z0-9]+', text.lower())
        meaningful = [w for w in words if w not in stop][:4]
        slug = '-'.join(meaningful) or 'project'
        return slug[:30].rstrip('-')

    dep_map = build_dependency_map(state["workspace_path"])

    workspace_summary = "\n".join(
        f"{f}: depends on {deps}" for f, deps in dep_map.items()
    ) or "Empty workspace — no Python files found."

    workspace_context = _read_workspace_context(state["workspace_path"])

    prompt = f"""You are CodePlan, a repository mapper for an AI coding system.

User task: {state["user_prompt"]}

Existing codebase context:
{workspace_context}

Workspace dependency map:
{workspace_summary}

Generate an execution plan (max 10 steps) and a short project name.

Respond as a JSON object:
{{
  "project_name": "kebab-case-name-max-30-chars",
  "plan": ["step 1", "step 2", ...],
  "risky_overwrites": ["file1.py"]
}}"""

    text = _call_llm(prompt, state["google_api_key"])
    match = re.search(r"\{.*\}", text, re.DOTALL)
    parsed = json.loads(match.group()) if match else {"plan": [text], "risky_overwrites": []}

    raw_name = parsed.get("project_name", "") or _slugify(state["user_prompt"])
    project_name = _re.sub(r'[^a-z0-9-]', '', raw_name.lower())[:30] or _slugify(state["user_prompt"])
    project_dir = Path(state["workspace_path"]) / project_name
    project_dir.mkdir(parents=True, exist_ok=True)

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
    _broadcast_ws({"type": "file_tree", "tree": _build_tree(str(project_dir), str(project_dir))})

    return {
        "file_dependency_map": dep_map,
        "execution_plan": parsed.get("plan", []),
        "project_dir": str(project_dir),
        "current_agent": "parsel",
        "step_count": 1,
        "last_telemetry": {
            "agent": "codeplan",
            "state": "complete",
            "message": f"Mapped {len(dep_map)} files. Plan has {len(parsed.get('plan', []))} steps.",
        },
    }
