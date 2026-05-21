"""
SWE-Agent v2 — Agentic Tool Loop.

Pattern: Claude Code / Codex style.
  The LLM drives itself with 7 tools until task_done() or MAX_AGENT_STEPS.
  Tools: read_file, write_file, edit_file, run_bash, list_dir, search_code, task_done.

Strategy:
  1. Build rich system prompt (workspace tree + plan + context).
  2. Start agentic loop — LLM picks tools, sees results, iterates.
  3. Each tool call is executed and fed back as function_response.
  4. HITL only for explicitly destructive bash commands.
  5. Falls back to one-shot JSON mode if function calling unavailable.
"""
import json
import re
import os
import subprocess
from pathlib import Path
from google.genai import types as _gt

from backend.orchestrator.state import VantageState
from backend.sandbox.docker_runner import DockerRunner
from backend.broadcast import broadcast as _broadcast_ws
from backend.agents.utils import call_llm, call_llm_with_tools_turn, make_tool_response_content

MODEL = "gemma-4-26b-a4b-it"
MAX_AGENT_STEPS = 30
MAX_FILE_READ = 8000       # chars per file read
MAX_CMD_OUTPUT = 2000      # chars of bash output fed back to LLM
MAX_SEARCH_OUTPUT = 3000   # chars of grep results

DANGEROUS_CMD_PATTERNS = [
    "rm -rf", "rm -f", "rmdir /s", "rmdir /q",
    "DROP TABLE", "DROP DATABASE", "TRUNCATE TABLE", "DELETE FROM",
    "format c:", "mkfs", "dd if=", ":(){ :|:& };:", "> /dev/sda",
    "shred ", "wipefs",
]
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build", ".next"}


# ── Helpers ────────────────────────────────────────────────────────────────

def _is_dangerous(cmd: str) -> bool:
    return any(p.lower() in cmd.lower() for p in DANGEROUS_CMD_PATTERNS)


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


def _workspace_tree_text(work_dir: str, max_entries: int = 120) -> str:
    """Compact text tree for the system prompt."""
    lines: list[str] = []
    count = 0
    root = Path(work_dir)
    for p in sorted(root.rglob("*")):
        if count >= max_entries:
            lines.append(f"  ... (+{count}+ more)")
            break
        parts = set(p.parts)
        if parts & SKIP_DIRS:
            continue
        rel = p.relative_to(root)
        indent = "  " * (len(rel.parts) - 1)
        icon = "📁" if p.is_dir() else "📄"
        lines.append(f"{indent}{icon} {p.name}")
        count += 1
    return "\n".join(lines) or "(empty workspace)"


# ── Tool declarations ──────────────────────────────────────────────────────

def _make_tool_declarations() -> list | None:
    """Build genai FunctionDeclaration list. Returns None on import failure."""
    try:
        from google.genai import types

        def _decl(name, description, props, required):
            return types.FunctionDeclaration(
                name=name,
                description=description,
                parameters=types.Schema(
                    type="OBJECT",
                    properties={k: types.Schema(**v) for k, v in props.items()},
                    required=required,
                ),
            )

        return [
            _decl(
                "read_file",
                "Read the full content of a file in the workspace. "
                "ALWAYS read a file before editing it.",
                {"path": {"type": "STRING", "description": "Relative path from workspace root, e.g. 'src/main.py'"}},
                ["path"],
            ),
            _decl(
                "write_file",
                "Create or completely overwrite a file. Use for new files. "
                "For targeted changes to existing files, prefer edit_file.",
                {
                    "path": {"type": "STRING", "description": "Relative path"},
                    "content": {"type": "STRING", "description": "Complete file content"},
                },
                ["path", "content"],
            ),
            _decl(
                "edit_file",
                "Replace one exact string in a file. Preferred for surgical changes — "
                "preserves surrounding code. Fails if old_string is not found exactly.",
                {
                    "path": {"type": "STRING", "description": "Relative path"},
                    "old_string": {"type": "STRING", "description": "Exact string to replace (must exist verbatim)"},
                    "new_string": {"type": "STRING", "description": "Replacement text"},
                },
                ["path", "old_string", "new_string"],
            ),
            _decl(
                "run_bash",
                "Run a shell command in the Docker sandbox (/workspace). "
                "Use for: pip install, npm install, running tests, linting, "
                "syntax checks, build steps.",
                {"command": {"type": "STRING", "description": "Shell command to run"}},
                ["command"],
            ),
            _decl(
                "list_dir",
                "List files and directories at a given path. "
                "Use '.' for workspace root. Use before creating files to avoid overwrites.",
                {"path": {"type": "STRING", "description": "Relative directory path (use '.' for root)"}},
                ["path"],
            ),
            _decl(
                "search_code",
                "Search for a text pattern or regex across all workspace files. "
                "Returns matching filenames and line content. "
                "Use to find where functions/classes are defined.",
                {
                    "pattern": {"type": "STRING", "description": "Text or regex pattern"},
                    "file_glob": {"type": "STRING", "description": "Optional glob filter, e.g. '*.py' or '*.ts'. Defaults to '*'"},
                },
                ["pattern"],
            ),
            _decl(
                "task_done",
                "Signal that the coding task is fully complete. "
                "Call ONLY when all files are written and verified (tests pass or no errors).",
                {"summary": {"type": "STRING", "description": "What was built or changed"}},
                ["summary"],
            ),
        ]
    except Exception as e:
        print(f"[VANTAGE/swe] tool declaration failed: {e}")
        return None


# ── Entry point ────────────────────────────────────────────────────────────

def run_swe_agent(state: VantageState) -> dict:
    work_dir = Path(state.get("project_dir") or state["workspace_path"])
    runner = DockerRunner(str(work_dir))
    skip_hitl = state.get("hitl_approved") is True

    tool_decls = _make_tool_declarations()
    if tool_decls:
        try:
            return _run_agentic_loop(state, work_dir, runner, tool_decls, skip_hitl)
        except Exception as e:
            _broadcast_ws({
                "type": "agent_token",
                "agent": "swe_agent",
                "text": f"\n⚠️ Agentic loop failed ({e}). Falling back to one-shot mode.\n",
            })

    return _run_oneshot(state, work_dir, runner, skip_hitl)


# ── Agentic loop ───────────────────────────────────────────────────────────

def _run_agentic_loop(
    state: VantageState,
    work_dir: Path,
    runner: DockerRunner,
    tool_decls: list,
    skip_hitl: bool,
) -> dict:
    """
    LLM-driven tool loop. Runs until task_done() is called or MAX_AGENT_STEPS reached.
    """
    # Mutable shared state for tool closures
    ctx: dict = {
        "code_changes": [],
        "done": False,
        "done_summary": "",
        "hitl_required": False,
        "hitl_type": None,
        "hitl_description": None,
    }

    # ── Tool executor ──────────────────────────────────────────────────────
    def _exec(name: str, args: dict) -> str:
        _broadcast_ws({"type": "tool_call", "agent": "swe_agent", "tool": name, "args": args})

        if name == "read_file":
            path = args.get("path", "").lstrip("/\\")
            try:
                target = work_dir / path
                text = target.read_text(encoding="utf-8", errors="replace")
                if len(text) > MAX_FILE_READ:
                    text = text[:MAX_FILE_READ] + "\n... [truncated — file continues]"
                return text
            except FileNotFoundError:
                return f"ERROR: '{path}' not found. Use list_dir to check available files."
            except Exception as exc:
                return f"ERROR: {exc}"

        elif name == "write_file":
            path = args.get("path", "").lstrip("/\\")
            content = args.get("content", "")
            try:
                target = work_dir / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(content, encoding="utf-8")
                ctx["code_changes"].append({"path": path, "content": content, "action": "create"})
                _broadcast_ws({"type": "file_write", "path": path, "content": content})
                return f"✓ Written: {path}  ({len(content):,} chars)"
            except Exception as exc:
                return f"ERROR: {exc}"

        elif name == "edit_file":
            path = args.get("path", "").lstrip("/\\")
            old_str = args.get("old_string", "")
            new_str = args.get("new_string", "")
            try:
                target = work_dir / path
                original = target.read_text(encoding="utf-8", errors="replace")
                if old_str not in original:
                    return (
                        f"ERROR: exact string not found in '{path}'. "
                        "Read the file first to verify the exact text."
                    )
                updated = original.replace(old_str, new_str, 1)
                target.write_text(updated, encoding="utf-8")
                ctx["code_changes"].append({"path": path, "content": updated, "action": "modify"})
                _broadcast_ws({"type": "file_write", "path": path, "content": updated})
                return f"✓ Edited: {path}"
            except FileNotFoundError:
                return f"ERROR: '{path}' not found. Use write_file to create it first."
            except Exception as exc:
                return f"ERROR: {exc}"

        elif name == "run_bash":
            cmd = args.get("command", "")
            if not skip_hitl and _is_dangerous(cmd):
                ctx["hitl_required"] = True
                ctx["hitl_type"] = "dangerous_command"
                ctx["hitl_description"] = f"SWE-agent wants to run: {cmd}"
                return f"⛔ PAUSED — human approval required for: {cmd}"
            result = runner.run_command(cmd)
            out = (result.get("output") or "")[:MAX_CMD_OUTPUT]
            if result["success"]:
                return f"✓ exit 0\n{out}" if out else "✓ exit 0 (no output)"
            err = (result.get("error") or "")[:500]
            return f"✗ non-zero exit\n{out}\n{err}"

        elif name == "list_dir":
            path = args.get("path", ".").lstrip("/\\")
            try:
                target = work_dir / path if path != "." else work_dir
                entries = sorted(os.scandir(str(target)), key=lambda e: (not e.is_dir(), e.name))
                lines = []
                for e in entries[:80]:
                    icon = "📁" if e.is_dir() else "📄"
                    lines.append(f"{icon} {e.name}")
                suffix = f"\n... ({len(entries) - 80} more)" if len(entries) > 80 else ""
                return "\n".join(lines) + suffix if lines else "(empty)"
            except Exception as exc:
                return f"ERROR: {exc}"

        elif name == "search_code":
            pattern = args.get("pattern", "")
            file_glob = args.get("file_glob", "*")
            try:
                cmd = f'grep -rn --include="{file_glob}" "{pattern}" .'
                res = subprocess.run(
                    cmd, shell=True, cwd=str(work_dir),
                    capture_output=True, text=True, timeout=15,
                )
                out = res.stdout[:MAX_SEARCH_OUTPUT]
                return out if out.strip() else "No matches found."
            except Exception as exc:
                return f"ERROR: {exc}"

        elif name == "task_done":
            ctx["done"] = True
            ctx["done_summary"] = args.get("summary", "Task complete.")
            return "✓ Task marked done."

        return f"Unknown tool: {name}"

    # ── System prompt ──────────────────────────────────────────────────────
    tree_text = _workspace_tree_text(str(work_dir))
    plan_text = "\n".join(f"  {i+1}. {s}" for i, s in enumerate(state.get("execution_plan", [])))
    tasks_json = json.dumps(state.get("decomposed_tasks", []), indent=2)

    system_prompt = f"""You are SWE-Agent, an expert autonomous software engineer running inside a secure Docker sandbox.
Your working directory is /workspace. All file paths are relative to this root.

━━━ TOOLS ━━━
You have 7 tools. Use them in sequence to explore, implement, and verify.

━━━ APPROACH (follow exactly) ━━━
1. Explore: call list_dir('.') — understand what already exists
2. Read: call read_file() on every file you plan to modify — never edit blind
3. Search: use search_code() to find where things are defined
4. Implement: write_file() for new files, edit_file() for targeted changes
5. Verify: run_bash() to install deps, run tests, check syntax
6. Fix: if errors, read the failing file, fix, re-run
7. Done: call task_done() ONLY when tests pass or no errors remain

━━━ RULES ━━━
• ALWAYS read a file before editing it
• write_file() rewrites the ENTIRE file — only use for new files or total rewrites
• edit_file() for surgical changes — it fails if old_string is not exact
• After writing files, verify with run_bash (python -c "import ast; ast.parse(open('file.py').read())" or similar)
• Produce complete, production-ready code — no stubs, no TODO, no placeholders
• Never guess a file path — use list_dir() first

━━━ WORKSPACE STRUCTURE ━━━
{tree_text}

━━━ USER TASK ━━━
{state["user_prompt"]}

━━━ EXECUTION PLAN ━━━
{plan_text or "  (none — derive your own plan)"}

━━━ SUBTASKS FROM PARSEL ━━━
{tasks_json}

Begin now. Start with list_dir('.') to confirm the workspace state."""

    # ── Initialize conversation ────────────────────────────────────────────
    history = [
        _gt.Content(
            role="user",
            parts=[_gt.Part(text="Start implementing. Explore the workspace first, then build step by step.")],
        )
    ]

    # ── Loop ──────────────────────────────────────────────────────────────
    steps_taken = 0
    for step in range(MAX_AGENT_STEPS):
        steps_taken = step + 1

        if ctx["done"] or ctx["hitl_required"]:
            break

        text, func_calls, model_content = call_llm_with_tools_turn(
            MODEL, system_prompt, history, tool_decls, state["google_api_key"]
        )

        # Stream any plain-text reasoning to frontend
        if text.strip():
            _broadcast_ws({"type": "agent_token", "agent": "swe_agent", "text": text})

        # Append model turn to history
        history.append(model_content)

        if not func_calls:
            # Model gave pure text with no tool calls — consider done
            ctx["done"] = True
            ctx["done_summary"] = text[:400]
            break

        # Execute tools and collect responses
        tool_responses: list[tuple[str, str]] = []
        for fc in func_calls:
            result_text = _exec(fc["name"], fc["args"])
            # tool_call event already broadcast inside _exec — no duplicate needed
            tool_responses.append((fc["name"], result_text))

            if ctx["hitl_required"] or ctx["done"]:
                break

        # Feed results back as a single user turn
        if tool_responses:
            history.append(make_tool_response_content(tool_responses))

    # ── Broadcast final file tree ──────────────────────────────────────────
    if ctx["code_changes"]:
        _broadcast_ws({
            "type": "file_tree",
            "tree": _build_tree(str(work_dir), str(work_dir)),
        })

    # ── HITL pause ─────────────────────────────────────────────────────────
    if ctx["hitl_required"]:
        return {
            "hitl_required": True,
            "hitl_type": ctx["hitl_type"],
            "hitl_description": ctx["hitl_description"],
            "status": "hitl_pause",
            "current_agent": "swe_agent",
            "step_count": 1,
            "last_telemetry": {
                "agent": "swe_agent",
                "state": "waiting_approval",
                "message": ctx["hitl_description"],
            },
        }

    # ── Complete ───────────────────────────────────────────────────────────
    code_changes = ctx["code_changes"]
    summary = ctx["done_summary"] or f"Wrote {len(code_changes)} file(s) in {steps_taken} step(s)."

    return {
        "code_changes": code_changes,
        "last_command_output": "",
        "last_error": None,
        "hitl_required": False,
        "hitl_approved": None,
        "current_agent": "autocoderover",
        "step_count": 1,
        "last_telemetry": {
            "agent": "swe_agent",
            "state": "complete",
            "message": summary,
        },
    }


# ── One-shot fallback ──────────────────────────────────────────────────────

def _run_oneshot(
    state: VantageState,
    work_dir: Path,
    runner: DockerRunner,
    skip_hitl: bool,
) -> dict:
    """Original one-shot approach — used when function calling is unavailable."""
    def _on_chunk(text: str):
        _broadcast_ws({"type": "agent_token", "agent": "swe_agent", "text": text})

    tasks_text = json.dumps(state.get("decomposed_tasks", []), indent=2)
    plan_text = "\n".join(state.get("execution_plan", []))

    prompt = f"""You are SWE-agent, an autonomous code writer inside a Docker sandbox.
Working directory: /workspace

User task: {state["user_prompt"]}

Execution plan:
{plan_text}

Decomposed tasks:
{tasks_text}

Write production-ready code. Respond with valid JSON only:
{{
  "files": [
    {{"path": "relative/path.py", "content": "full file content", "action": "create"}}
  ],
  "commands": ["pip install requests", "python -m pytest tests/"]
}}

IMPORTANT: paths must be relative, no leading slash."""

    text = call_llm(MODEL, prompt, state["google_api_key"], on_chunk=_on_chunk)
    match = re.search(r"\{.*\}", text, re.DOTALL)
    result = json.loads(match.group()) if match else {"files": [], "commands": []}

    if not skip_hitl:
        dangerous = [cmd for cmd in result.get("commands", []) if _is_dangerous(cmd)]
        if dangerous:
            return {
                "hitl_required": True,
                "hitl_type": "dangerous_command",
                "hitl_description": f"SWE-agent wants to run: {'; '.join(dangerous)}",
                "status": "hitl_pause",
                "current_agent": "swe_agent",
                "step_count": 1,
                "last_telemetry": {
                    "agent": "swe_agent",
                    "state": "waiting_approval",
                    "message": f"Dangerous commands: {dangerous}",
                },
            }

    for file_spec in result.get("files", []):
        runner.write_file(file_spec["path"], file_spec["content"])
        _broadcast_ws({"type": "file_write", "path": file_spec["path"], "content": file_spec["content"]})

    _broadcast_ws({"type": "file_tree", "tree": _build_tree(str(work_dir), str(work_dir))})

    for cmd in result.get("commands", []):
        run_result = runner.run_command(cmd)
        if not run_result["success"]:
            break

    code_changes = result.get("files", [])
    return {
        "code_changes": code_changes,
        "last_command_output": "",
        "last_error": None,
        "hitl_required": False,
        "hitl_approved": None,
        "current_agent": "autocoderover",
        "step_count": 1,
        "last_telemetry": {
            "agent": "swe_agent",
            "state": "complete",
            "message": f"Wrote {len(code_changes)} file(s).",
        },
    }
