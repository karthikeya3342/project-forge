"""
CodePlan — repository mapper and execution planner.

Scans workspace, builds dependency graph, detects tech stack,
generates an ordered execution plan for SWE-Agent.
"""
import ast
import json
import re
import os
from pathlib import Path
from backend.orchestrator.state import VantageState
from backend.broadcast import broadcast as _broadcast_ws
from backend.agents.utils import call_llm

MODEL = "gemma-4-26b-a4b-it"

CODE_EXTS = {
    ".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
    ".cpp", ".c", ".h", ".hpp", ".java", ".go", ".rs",
    ".cs", ".rb", ".php", ".swift", ".kt", ".scala", ".r",
    ".sql", ".sh", ".bash", ".zsh",
}
SKIP_DIRS = {
    ".git", "node_modules", "__pycache__", ".venv", "venv",
    "dist", "build", ".next", ".cache", "coverage",
}
ENTRY_NAMES = {"main", "index", "app", "server", "cli", "run", "start", "manage"}
MANIFEST_FILES = {
    "package.json", "requirements.txt", "Pipfile", "pyproject.toml",
    "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "composer.json",
    "Gemfile", ".csproj",
}


def _call_llm(prompt: str, api_key: str) -> str:
    def _on_chunk(text: str):
        _broadcast_ws({"type": "agent_token", "agent": "codeplan", "text": text})
    return call_llm(MODEL, prompt, api_key, on_chunk=_on_chunk)


# ── Workspace analysis ─────────────────────────────────────────────────────

def _scan_workspace(workspace_path: str) -> dict:
    """
    Full workspace scan. Returns:
      - files: list of all code files (relative paths)
      - tech_stack: detected languages / frameworks
      - manifests: contents of package.json, requirements.txt, etc.
      - file_contents: {rel_path: content_preview} for top priority files
      - dep_map: {py_file: [imported_py_files]} (Python only)
    """
    root = Path(workspace_path)
    all_files: list[tuple[int, float, Path]] = []  # (priority, mtime, path)
    manifests: dict[str, str] = {}
    tech_flags: set[str] = set()
    dep_map: dict[str, list[str]] = {}

    for entry in root.rglob("*"):
        if not entry.is_file():
            continue
        parts = set(entry.parts)
        if parts & {str(root / d) for d in SKIP_DIRS}:
            continue
        # simpler dir check
        rel_parts = entry.relative_to(root).parts
        if any(p in SKIP_DIRS for p in rel_parts):
            continue

        name = entry.name.lower()

        # Manifests
        if name in MANIFEST_FILES:
            try:
                content = entry.read_text(encoding="utf-8", errors="ignore")
                manifests[str(entry.relative_to(root))] = content[:1500]
                # Detect stack from manifests
                if name == "package.json":
                    tech_flags.update(["JavaScript/TypeScript", "Node.js"])
                    try:
                        pkg = json.loads(content)
                        deps = {**pkg.get("dependencies", {}), **pkg.get("devDependencies", {})}
                        if "react" in deps:
                            tech_flags.add("React")
                        if "next" in deps:
                            tech_flags.add("Next.js")
                        if "vue" in deps:
                            tech_flags.add("Vue.js")
                        if "express" in deps:
                            tech_flags.add("Express.js")
                        if "fastapi" in deps or "uvicorn" in deps:
                            tech_flags.add("FastAPI")
                    except Exception:
                        pass
                elif name in ("requirements.txt", "pipfile", "pyproject.toml"):
                    tech_flags.add("Python")
                elif name == "cargo.toml":
                    tech_flags.add("Rust")
                elif name == "go.mod":
                    tech_flags.add("Go")
                elif name in ("pom.xml", "build.gradle"):
                    tech_flags.add("Java")
            except Exception:
                pass

        # Code files
        if entry.suffix in CODE_EXTS:
            priority = 0 if entry.stem.lower() in ENTRY_NAMES else 1
            all_files.append((priority, entry.stat().st_mtime, entry))

            # Python dependency map
            if entry.suffix == ".py":
                rel = str(entry.relative_to(root))
                deps = []
                try:
                    tree = ast.parse(entry.read_text(encoding="utf-8", errors="ignore"))
                    for node in ast.walk(tree):
                        if isinstance(node, (ast.Import, ast.ImportFrom)):
                            module = ""
                            if isinstance(node, ast.ImportFrom) and node.module:
                                module = node.module.replace(".", "/") + ".py"
                            elif isinstance(node, ast.Import):
                                for alias in node.names:
                                    module = alias.name.replace(".", "/") + ".py"
                            if module and (root / module).exists():
                                deps.append(module)
                except SyntaxError:
                    pass
                dep_map[rel] = deps

            # Infer tech stack from extensions
            if entry.suffix in (".ts", ".tsx"):
                tech_flags.add("TypeScript")
            elif entry.suffix in (".js", ".jsx"):
                tech_flags.add("JavaScript")
            elif entry.suffix == ".py":
                tech_flags.add("Python")
            elif entry.suffix == ".go":
                tech_flags.add("Go")
            elif entry.suffix == ".rs":
                tech_flags.add("Rust")
            elif entry.suffix in (".java",):
                tech_flags.add("Java")

    # Sort: entry points first, then by recency
    all_files.sort(key=lambda x: (x[0], -x[1]))

    # Build content previews for top 15 files
    file_contents: dict[str, str] = {}
    for _, _, f in all_files[:15]:
        try:
            rel = str(f.relative_to(root))
            content = f.read_text(encoding="utf-8", errors="ignore")[:2500]
            file_contents[rel] = content
        except Exception:
            pass

    return {
        "files": [str(f.relative_to(root)) for _, _, f in all_files],
        "tech_stack": sorted(tech_flags),
        "manifests": manifests,
        "file_contents": file_contents,
        "dep_map": dep_map,
    }


def _build_context_block(scan: dict) -> str:
    """Compact context block for the LLM prompt."""
    parts: list[str] = []

    if scan["tech_stack"]:
        parts.append(f"**Tech stack:** {', '.join(scan['tech_stack'])}")

    if scan["manifests"]:
        for name, content in list(scan["manifests"].items())[:3]:
            parts.append(f"\n### {name}\n```\n{content[:800]}\n```")

    if scan["file_contents"]:
        parts.append("\n### Key files (entry points + recent)")
        for rel, content in list(scan["file_contents"].items())[:10]:
            parts.append(f"\n#### {rel}\n```\n{content[:1500]}\n```")

    total = len(scan["files"])
    if total > 0:
        parts.append(f"\n**Total code files:** {total}")

    return "\n".join(parts) if parts else "Empty workspace — no code files found."


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


def _slugify(text: str) -> str:
    stop = {
        "write", "a", "an", "the", "to", "for", "in",
        "create", "make", "build", "implement", "code",
        "program", "script", "that", "which", "with", "using", "develop",
    }
    words = re.findall(r"[a-z0-9]+", text.lower())
    meaningful = [w for w in words if w not in stop][:4]
    slug = "-".join(meaningful) or "project"
    return slug[:30].rstrip("-")


# ── Main ───────────────────────────────────────────────────────────────────

def run_codeplan(state: VantageState) -> dict:
    workspace_path = state["workspace_path"]

    # Full workspace scan
    scan = _scan_workspace(workspace_path)
    context_block = _build_context_block(scan)

    dep_summary = "\n".join(
        f"  {f} → {deps}" for f, deps in list(scan["dep_map"].items())[:20]
    ) or "  (none — no Python files or empty workspace)"

    prompt = f"""You are CodePlan, a senior repository architect for an autonomous AI coding system.

## User task
{state["user_prompt"]}

## Existing codebase
{context_block}

## Python import dependency map
{dep_summary}

## Your job
Analyze the task and existing code. Generate:
1. A short kebab-case project name (max 30 chars)
2. An ordered execution plan (max 12 steps, most important first)
3. Files that might be overwritten (risky_overwrites)

Rules:
- If existing code is relevant, the plan must BUILD ON IT, not replace it
- Steps should be concrete ("Create src/models/user.py with User dataclass")
- Sequence matters — foundations before features, imports before usages

Respond ONLY with valid JSON, no markdown fences:
{{
  "project_name": "kebab-case-name",
  "plan": [
    "Step 1: ...",
    "Step 2: ..."
  ],
  "risky_overwrites": ["src/main.py"]
}}"""

    text = _call_llm(prompt, state["google_api_key"])
    clean = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.DOTALL)
    match = re.search(r"\{.*\}", clean, re.DOTALL)
    parsed = json.loads(match.group()) if match else {"plan": [text[:200]], "risky_overwrites": []}

    # Build project subdirectory
    raw_name = parsed.get("project_name", "") or _slugify(state["user_prompt"])
    project_name = re.sub(r"[^a-z0-9-]", "", raw_name.lower())[:30] or _slugify(state["user_prompt"])
    project_dir = Path(workspace_path) / project_name
    project_dir.mkdir(parents=True, exist_ok=True)

    # Broadcast
    _broadcast_ws({"type": "dependency_map", "map": scan["dep_map"]})
    _broadcast_ws({
        "type": "file_tree",
        "tree": _build_tree(str(project_dir), str(project_dir)),
    })

    return {
        "file_dependency_map": scan["dep_map"],
        "execution_plan": parsed.get("plan", []),
        "project_dir": str(project_dir),
        "current_agent": "parsel",
        "step_count": 1,
        "last_telemetry": {
            "agent": "codeplan",
            "state": "complete",
            "message": (
                f"Mapped {len(scan['files'])} files. "
                f"Stack: {', '.join(scan['tech_stack']) or 'unknown'}. "
                f"Plan: {len(parsed.get('plan', []))} steps."
            ),
        },
    }
