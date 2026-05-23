"""
SWE-Agent v3 — Trustworthy Agentic Tool Loop.

Trust pillars (what separates this from a toy agent):
  1. VERIFICATION  — auto-verify syntax/tests before task_done. Can't ship broken code.
  2. REVERSIBILITY — git init at start, auto-commit after each verified write.
  3. TRANSPARENCY  — broadcast unified diffs so user sees exactly what changed.
  4. QUALITY GATE  — task_done blocked if verification fails; agent must fix first.

Pattern: Claude Code / Codex style.
  The LLM drives itself with 9 tools until task_done() or MAX_AGENT_STEPS.
  Tools: read_file, write_file, edit_file, run_bash, list_dir, search_code,
         verify, git_log, task_done.
"""
import difflib
import json
import re
import os
import subprocess
import threading
import time
from pathlib import Path
from google.genai import types as _gt

from backend.orchestrator.state import VantageState
from backend.sandbox.docker_runner import DockerRunner
from backend.broadcast import broadcast as _broadcast_ws
from backend.agents.utils import call_llm, call_llm_with_tools_turn, make_tool_response_content

MODEL = "gemma-4-26b-a4b-it"


# ── API rate limiter — shared across ALL parallel workers ──────────────────
# Gemma API: 15 req/min → use 13 for safety margin

class _RateLimiter:
    """Sliding-window token bucket. Thread-safe."""
    def __init__(self, max_per_minute: int):
        self._lock = threading.Lock()
        self._calls: list[float] = []
        self._max = max_per_minute

    def acquire(self) -> None:
        """Block until a request slot is available."""
        while True:
            with self._lock:
                now = time.monotonic()
                self._calls = [t for t in self._calls if now - t < 60.0]
                if len(self._calls) < self._max:
                    self._calls.append(now)
                    return
            time.sleep(0.5)


_rate_limiter = _RateLimiter(max_per_minute=13)


def _detect_shell_env(work_dir: Path) -> str:
    """Detect runtime shell so the LLM uses correct command syntax."""
    import platform
    runner = DockerRunner(str(work_dir))
    docker_ok = runner._get_client() is not None
    if docker_ok:
        return (
            "Commands execute inside a **Docker container** (Linux, bash shell). "
            "Use standard bash syntax: ls, grep, cat, pip, python, npm, node."
        )
    os_name = platform.system()
    if os_name == "Windows":
        return (
            "Commands execute locally on **Windows** via subprocess (no Docker). "
            "Use cross-platform commands: python, pip, npm, node. "
            "For file listing use: python -c \"import os; print(os.listdir('.'))\" "
            "Avoid bash-only syntax (ls, grep, cat). Use python -c for complex ops."
        )
    return f"Commands execute locally on **{os_name}** via subprocess. Use bash syntax."

MAX_AGENT_STEPS = 20
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


# ── Trust pillar helpers ────────────────────────────────────────────────────

def _compute_diff(old_content: str, new_content: str, path: str) -> str:
    """Unified diff between old and new file content."""
    old_lines = old_content.splitlines(keepends=True)
    new_lines = new_content.splitlines(keepends=True)
    diff = difflib.unified_diff(
        old_lines, new_lines,
        fromfile=f"a/{path}",
        tofile=f"b/{path}",
        lineterm="",
    )
    return "".join(diff)


def _init_git(work_dir: Path) -> bool:
    """Git init in project dir. Returns True if git is available."""
    try:
        # Check git available
        r = subprocess.run(["git", "--version"], capture_output=True, timeout=5)
        if r.returncode != 0:
            return False
        # Init if not already a repo
        git_dir = work_dir / ".git"
        if not git_dir.exists():
            subprocess.run(["git", "init"], cwd=str(work_dir), capture_output=True, timeout=10)
            subprocess.run(
                ["git", "config", "user.email", "vantage@local"],
                cwd=str(work_dir), capture_output=True, timeout=5,
            )
            subprocess.run(
                ["git", "config", "user.name", "VANTAGE"],
                cwd=str(work_dir), capture_output=True, timeout=5,
            )
            # .gitignore
            gitignore = work_dir / ".gitignore"
            if not gitignore.exists():
                gitignore.write_text(
                    "__pycache__/\n*.pyc\n.venv/\nvenv/\nnode_modules/\ndist/\nbuild/\n.env\n",
                    encoding="utf-8",
                )
        return True
    except Exception:
        return False


def _git_commit(work_dir: Path, message: str) -> str:
    """Stage all changes and commit. Returns commit hash or error."""
    try:
        subprocess.run(["git", "add", "-A"], cwd=str(work_dir), capture_output=True, timeout=10)
        r = subprocess.run(
            ["git", "commit", "-m", message, "--allow-empty"],
            cwd=str(work_dir), capture_output=True, text=True, timeout=15,
        )
        if r.returncode == 0:
            # Get short hash
            h = subprocess.run(
                ["git", "rev-parse", "--short", "HEAD"],
                cwd=str(work_dir), capture_output=True, text=True, timeout=5,
            )
            return h.stdout.strip() if h.returncode == 0 else "committed"
        return f"commit failed: {r.stderr[:200]}"
    except Exception as e:
        return f"git error: {e}"


def _git_log(work_dir: Path, n: int = 5) -> str:
    """Return last N commits as readable log."""
    try:
        r = subprocess.run(
            ["git", "log", f"--oneline", f"-{n}"],
            cwd=str(work_dir), capture_output=True, text=True, timeout=5,
        )
        return r.stdout.strip() or "(no commits yet)"
    except Exception:
        return "(git not available)"


def _auto_verify(work_dir: Path, written_files: list[str]) -> dict:
    """
    Verify all written files for syntax errors.
    Returns {"passed": bool, "errors": [str], "summary": str}
    """
    errors: list[str] = []

    for rel_path in written_files:
        target = work_dir / rel_path
        if not target.exists():
            continue
        suffix = target.suffix.lower()

        if suffix == ".py":
            try:
                import ast
                src = target.read_text(encoding="utf-8", errors="replace")
                ast.parse(src)
            except SyntaxError as e:
                errors.append(f"{rel_path}: Python syntax error at line {e.lineno}: {e.msg}")

        elif suffix in (".js", ".jsx", ".ts", ".tsx", ".mjs"):
            # Quick check: balanced braces
            try:
                src = target.read_text(encoding="utf-8", errors="replace")
                if src.count("{") != src.count("}"):
                    errors.append(f"{rel_path}: Unbalanced braces ({{ vs }})")
                if src.count("(") != src.count(")"):
                    errors.append(f"{rel_path}: Unbalanced parentheses")
            except Exception:
                pass

        elif suffix == ".json":
            try:
                import json as _json
                _json.loads(target.read_text(encoding="utf-8", errors="replace"))
            except _json.JSONDecodeError as e:
                errors.append(f"{rel_path}: JSON parse error: {e}")

    # Run pytest if available
    pytest_result = None
    test_files = [f for f in written_files if "test" in f.lower() and f.endswith(".py")]
    if test_files:
        try:
            r = subprocess.run(
                ["python", "-m", "pytest", "--tb=short", "-q"] + test_files,
                cwd=str(work_dir), capture_output=True, text=True, timeout=60,
            )
            if r.returncode != 0:
                out = (r.stdout + r.stderr)[:600]
                errors.append(f"Tests failed:\n{out}")
            else:
                pytest_result = (r.stdout + r.stderr).strip().split("\n")[-1]
        except FileNotFoundError:
            pass  # pytest not installed yet
        except Exception:
            pass

    passed = len(errors) == 0
    if passed:
        summary = f"Verification passed — {len(written_files)} file(s) clean"
        if pytest_result:
            summary += f" | {pytest_result}"
    else:
        summary = f"Verification FAILED — {len(errors)} issue(s) found"

    return {"passed": passed, "errors": errors, "summary": summary}


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
                "verify",
                "Verify all written files for syntax errors and run tests. "
                "ALWAYS call this before task_done. If it fails, fix the errors first.",
                {},
                [],
            ),
            _decl(
                "git_log",
                "Show the last 5 git commits in the project directory. "
                "Use to confirm previous changes were committed.",
                {},
                [],
            ),
            _decl(
                "task_done",
                "Signal that the coding task is fully complete. "
                "ONLY call after verify() passes with no errors. "
                "Blocked automatically if verification fails.",
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

    # TRUST PILLAR 2: Reversibility — init git at start
    git_available = _init_git(work_dir)
    if git_available:
        _broadcast_ws({"type": "agent_token", "agent": "swe_agent",
                       "text": "Git initialized — all changes committed automatically."})

    tool_decls = _make_tool_declarations()
    if not tool_decls:
        return _run_oneshot(state, work_dir, runner, skip_hitl)

    # Parallel workers when Parsel decomposed the tasks
    decomposed = state.get("decomposed_tasks", [])
    if len(decomposed) >= 2:
        try:
            return _run_parallel_workers(state, work_dir, runner, tool_decls, skip_hitl, git_available)
        except Exception as e:
            _broadcast_ws({
                "type": "agent_token", "agent": "swe_agent",
                "text": f"Parallel mode failed ({e}). Running single worker.",
            })

    # Single worker loop (simple tasks or fallback)
    try:
        return _run_agentic_loop(state, work_dir, runner, tool_decls, skip_hitl, git_available)
    except Exception as e:
        _broadcast_ws({
            "type": "agent_token", "agent": "swe_agent",
            "text": f"Agentic loop failed ({e}). Falling back to one-shot mode.",
        })

    return _run_oneshot(state, work_dir, runner, skip_hitl)


# ── Parallel workers ──────────────────────────────────────────────────────

def _run_worker_loop(
    worker_id: int,
    task: dict,
    state: VantageState,
    work_dir: Path,
    runner: "DockerRunner",
    tool_decls: list,
    skip_hitl: bool,
    git_available: bool,
    total_workers: int,
    all_tasks: list[dict],
) -> dict:
    """
    Focused single-task agentic loop for one parallel worker.
    Returns {"code_changes": [...], "hitl_required": bool, ...}
    """
    agent_name = f"worker_{worker_id}"
    step_index = task.get("step_index", worker_id)

    _broadcast_ws({
        "type": "worker_start",
        "worker_id": worker_id,
        "task": task.get("purpose", ""),
        "step_index": step_index,
    })
    _broadcast_ws({
        "type": "plan_step_update",
        "step_index": step_index,
        "status": "working",
    })

    ctx: dict = {
        "code_changes": [],
        "done": False,
        "done_summary": "",
        "hitl_required": False,
        "hitl_type": None,
        "hitl_description": None,
    }

    def _exec(name: str, args: dict) -> str:
        _broadcast_ws({"type": "tool_call", "agent": agent_name, "tool": name, "args": args})

        if name == "read_file":
            path = args.get("path", "").lstrip("/\\")
            try:
                target = work_dir / path
                text = target.read_text(encoding="utf-8", errors="replace")
                return text[:MAX_FILE_READ] + "\n...[truncated]" if len(text) > MAX_FILE_READ else text
            except FileNotFoundError:
                return f"ERROR: '{path}' not found."
            except Exception as exc:
                return f"ERROR: {exc}"

        elif name == "write_file":
            path = args.get("path", "").lstrip("/\\")
            content = args.get("content", "")
            try:
                target = work_dir / path
                target.parent.mkdir(parents=True, exist_ok=True)
                old_content = target.read_text(encoding="utf-8", errors="replace") if target.exists() else ""
                action = "modify" if old_content else "create"
                target.write_text(content, encoding="utf-8")
                diff = _compute_diff(old_content, content, path)
                ctx["code_changes"].append({"path": path, "content": content, "action": action})
                _broadcast_ws({"type": "file_write", "path": path, "content": content})
                if diff:
                    _broadcast_ws({"type": "file_diff", "path": path, "diff": diff})
                return f"Written: {path} ({len(content):,} chars)"
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
                    return f"ERROR: exact string not found in '{path}'."
                updated = original.replace(old_str, new_str, 1)
                diff = _compute_diff(original, updated, path)
                target.write_text(updated, encoding="utf-8")
                ctx["code_changes"].append({"path": path, "content": updated, "action": "modify"})
                _broadcast_ws({"type": "file_write", "path": path, "content": updated})
                if diff:
                    _broadcast_ws({"type": "file_diff", "path": path, "diff": diff})
                return f"Edited: {path}"
            except FileNotFoundError:
                return f"ERROR: '{path}' not found."
            except Exception as exc:
                return f"ERROR: {exc}"

        elif name == "run_bash":
            cmd = args.get("command", "")
            if not skip_hitl and _is_dangerous(cmd):
                ctx["hitl_required"] = True
                ctx["hitl_type"] = "dangerous_command"
                ctx["hitl_description"] = f"Worker {worker_id} wants to run: {cmd}"
                return f"PAUSED — approval required for: {cmd}"
            result = runner.run_command(cmd)
            out = (result.get("output") or "")[:MAX_CMD_OUTPUT]
            return f"exit 0\n{out}" if result["success"] else f"non-zero exit\n{out}\n{(result.get('error') or '')[:200]}"

        elif name == "list_dir":
            path = args.get("path", ".").lstrip("/\\")
            try:
                target = work_dir / path if path != "." else work_dir
                entries = sorted(os.scandir(str(target)), key=lambda e: (not e.is_dir(), e.name))
                lines = [f"{'[D]' if e.is_dir() else '[F]'} {e.name}" for e in entries[:60]]
                return "\n".join(lines) or "(empty)"
            except Exception as exc:
                return f"ERROR: {exc}"

        elif name == "verify":
            written = [c["path"] for c in ctx["code_changes"]]
            if not written:
                return "Nothing written yet."
            result = _auto_verify(work_dir, written)
            _broadcast_ws({
                "type": "verification_result", "agent": agent_name,
                "passed": result["passed"], "summary": result["summary"], "errors": result["errors"],
            })
            return f"{'PASSED' if result['passed'] else 'FAILED'}: {result['summary']}" + (
                "\n" + "\n".join(result["errors"]) if not result["passed"] else ""
            )

        elif name == "task_done":
            written = [c["path"] for c in ctx["code_changes"]]
            if written:
                verify_result = _auto_verify(work_dir, written)
                _broadcast_ws({
                    "type": "verification_result", "agent": agent_name,
                    "passed": verify_result["passed"], "summary": verify_result["summary"],
                    "errors": verify_result["errors"],
                })
                if not verify_result["passed"]:
                    return (
                        f"BLOCKED — fix errors before task_done.\n{verify_result['summary']}\n"
                        + "\n".join(verify_result["errors"])
                    )
            ctx["done"] = True
            ctx["done_summary"] = args.get("summary", "Task complete.")
            return "Task marked done."

        return f"Unknown tool: {name}"

    # Worker system prompt — narrowly focused
    other_tasks = [
        f"  Worker {i}: {t.get('purpose', '')}"
        for i, t in enumerate(all_tasks) if i != worker_id
    ]
    tree_text = _workspace_tree_text(str(work_dir))

    system_prompt = f"""You are Worker {worker_id} of {total_workers} parallel agents.

{_detect_shell_env(work_dir)}

WORKSPACE:
{tree_text}

USER TASK CONTEXT: {state["user_prompt"]}

YOUR SPECIFIC JOB: {task.get("purpose", "")}
TARGET FILE: {task.get("signature", "(determine from your task)")}

OTHER WORKERS ARE HANDLING:
{chr(10).join(other_tasks) if other_tasks else "  (you are the only worker)"}

RULES:
• Focus ONLY on your assigned job. Do NOT touch other workers' files.
• Write complete production-ready code — no stubs, no TODOs.
• Call verify() after writing. Fix any errors. Then call task_done().
• Max 10 steps. Be fast."""

    history = [
        _gt.Content(
            role="user",
            parts=[_gt.Part(text=f"Start Worker {worker_id}. Implement your task now.")],
        )
    ]

    READ_ONLY_TOOLS = {"read_file", "list_dir"}
    MAX_WORKER_STEPS = 10

    for step in range(MAX_WORKER_STEPS):
        if ctx["done"] or ctx["hitl_required"]:
            break

        _rate_limiter.acquire()  # respect 15 req/min API limit
        text, func_calls, model_content = call_llm_with_tools_turn(
            MODEL, system_prompt, history, tool_decls, state["google_api_key"]
        )

        if text.strip():
            lines = [l.strip() for l in text.strip().split("\n") if l.strip()]
            useful = [l for l in lines if len(l) < 120 and not l.startswith(
                ("I ", "Let me ", "Now I ", "I'll ", "I need ", "I should ", "Okay", "Hmm", "Actually")
            )]
            if useful:
                _broadcast_ws({"type": "agent_token", "agent": agent_name, "text": "\n".join(useful)})

        history.append(model_content)

        if not func_calls:
            ctx["done"] = True
            ctx["done_summary"] = text[:300]
            break

        read_calls = [fc for fc in func_calls if fc["name"] in READ_ONLY_TOOLS]
        write_calls = [fc for fc in func_calls if fc["name"] not in READ_ONLY_TOOLS]

        tool_responses: list[tuple[str, str]] = []
        if len(read_calls) > 1:
            import concurrent.futures
            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                futs = {pool.submit(_exec, fc["name"], fc["args"]): fc for fc in read_calls}
                for fut in concurrent.futures.as_completed(futs):
                    fc = futs[fut]
                    tool_responses.append((fc["name"], fut.result()))
        elif read_calls:
            fc = read_calls[0]
            tool_responses.append((fc["name"], _exec(fc["name"], fc["args"])))

        for fc in write_calls:
            if ctx["hitl_required"] or ctx["done"]:
                break
            tool_responses.append((fc["name"], _exec(fc["name"], fc["args"])))

        if tool_responses:
            history.append(make_tool_response_content(tool_responses))

    # Mark step done in plan view
    files_written = [c["path"] for c in ctx["code_changes"]]
    _broadcast_ws({
        "type": "worker_complete",
        "worker_id": worker_id,
        "step_index": step_index,
        "files": files_written,
    })
    _broadcast_ws({
        "type": "plan_step_update",
        "step_index": step_index,
        "status": "done" if ctx["done"] else "error",
        "files": files_written,
    })

    return {
        "code_changes": ctx["code_changes"],
        "hitl_required": ctx["hitl_required"],
        "hitl_type": ctx.get("hitl_type"),
        "hitl_description": ctx.get("hitl_description"),
        "done_summary": ctx["done_summary"],
    }


def _run_parallel_workers(
    state: VantageState,
    work_dir: Path,
    runner: "DockerRunner",
    tool_decls: list,
    skip_hitl: bool,
    git_available: bool,
) -> dict:
    """Spawn parallel worker loops — each handles one decomposed task."""
    import concurrent.futures

    tasks = state.get("decomposed_tasks", [])
    # Rate limiter (module-level _rate_limiter) handles API quota automatically
    max_workers = min(5, len(tasks))
    worker_tasks = tasks[:max_workers]
    total_workers = len(worker_tasks)

    _broadcast_ws({
        "type": "agent_token",
        "agent": "swe_agent",
        "text": f"Spawning {total_workers} parallel workers...",
    })

    all_code_changes: list[dict] = []
    hitl_result: dict | None = None

    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as pool:
        future_map = {
            pool.submit(
                _run_worker_loop,
                worker_id, task, state, work_dir, runner, tool_decls,
                skip_hitl, git_available, total_workers, worker_tasks,
            ): (worker_id, task)
            for worker_id, task in enumerate(worker_tasks)
        }

        for fut in concurrent.futures.as_completed(future_map):
            worker_id, task = future_map[fut]
            try:
                result = fut.result()
                if result.get("hitl_required") and not hitl_result:
                    hitl_result = result
                else:
                    all_code_changes.extend(result.get("code_changes", []))
            except Exception as exc:
                _broadcast_ws({
                    "type": "agent_token", "agent": "swe_agent",
                    "text": f"Worker {worker_id} crashed: {exc}",
                })

    # Handle remaining tasks (if tasks > max_workers) sequentially
    remaining = tasks[max_workers:]
    if remaining and not hitl_result:
        for i, task in enumerate(remaining):
            worker_id = max_workers + i
            result = _run_worker_loop(
                worker_id, task, state, work_dir, runner, tool_decls,
                skip_hitl, git_available, total_workers + len(remaining), tasks,
            )
            if result.get("hitl_required") and not hitl_result:
                hitl_result = result
                break
            all_code_changes.extend(result.get("code_changes", []))

    if hitl_result:
        return {
            "hitl_required": True,
            "hitl_type": hitl_result.get("hitl_type"),
            "hitl_description": hitl_result.get("hitl_description"),
            "status": "hitl_pause",
            "current_agent": "swe_agent",
            "step_count": 1,
            "last_telemetry": {
                "agent": "swe_agent",
                "state": "waiting_approval",
                "message": hitl_result.get("hitl_description", "Approval required."),
            },
        }

    # Single final git commit for all workers
    if git_available and all_code_changes:
        _broadcast_ws({"type": "file_tree", "tree": _build_tree(str(work_dir), str(work_dir))})
        commit_hash = _git_commit(work_dir, f"parallel: {len(all_code_changes)} files written")
        _broadcast_ws({
            "type": "git_commit", "agent": "swe_agent",
            "hash": commit_hash, "message": f"{len(all_code_changes)} files committed",
        })

    summary = f"Parallel workers complete: {len(all_code_changes)} file(s) written by {total_workers} worker(s)."
    return {
        "code_changes": all_code_changes,
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


# ── Agentic loop ───────────────────────────────────────────────────────────

def _run_agentic_loop(
    state: VantageState,
    work_dir: Path,
    runner: DockerRunner,
    tool_decls: list,
    skip_hitl: bool,
    git_available: bool = False,
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
                # TRUST PILLAR 3: Transparency — diff before overwrite
                old_content = ""
                if target.exists():
                    try:
                        old_content = target.read_text(encoding="utf-8", errors="replace")
                    except Exception:
                        pass
                action = "modify" if old_content else "create"
                target.write_text(content, encoding="utf-8")
                diff = _compute_diff(old_content, content, path)
                ctx["code_changes"].append({"path": path, "content": content, "action": action})
                _broadcast_ws({"type": "file_write", "path": path, "content": content})
                if diff:
                    _broadcast_ws({"type": "file_diff", "path": path, "diff": diff})
                # Git staged at task_done — not per-write (avoids per-file subprocess overhead)
                return f"Written: {path} ({len(content):,} chars)"
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
                # TRUST PILLAR 3: Transparency — diff
                diff = _compute_diff(original, updated, path)
                target.write_text(updated, encoding="utf-8")
                ctx["code_changes"].append({"path": path, "content": updated, "action": "modify"})
                _broadcast_ws({"type": "file_write", "path": path, "content": updated})
                if diff:
                    _broadcast_ws({"type": "file_diff", "path": path, "diff": diff})
                # Git staged at task_done — not per-edit
                return f"Edited: {path}"
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
                return f"PAUSED — human approval required for: {cmd}"
            result = runner.run_command(cmd)
            out = (result.get("output") or "")[:MAX_CMD_OUTPUT]
            if result["success"]:
                return f"exit 0\n{out}" if out else "exit 0 (no output)"
            err = (result.get("error") or "")[:500]
            return f"non-zero exit\n{out}\n{err}"

        elif name == "list_dir":
            path = args.get("path", ".").lstrip("/\\")
            try:
                target = work_dir / path if path != "." else work_dir
                entries = sorted(os.scandir(str(target)), key=lambda e: (not e.is_dir(), e.name))
                lines = []
                for e in entries[:80]:
                    prefix = "[D]" if e.is_dir() else "[F]"
                    lines.append(f"{prefix} {e.name}")
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

        elif name == "verify":
            # TRUST PILLAR 1: Verification
            written_paths = [c["path"] for c in ctx["code_changes"]]
            if not written_paths:
                return "Nothing written yet — no files to verify."
            result = _auto_verify(work_dir, written_paths)
            _broadcast_ws({
                "type": "verification_result",
                "agent": "swe_agent",
                "passed": result["passed"],
                "summary": result["summary"],
                "errors": result["errors"],
            })
            if result["passed"]:
                return f"PASSED: {result['summary']}"
            return (
                f"FAILED: {result['summary']}\n\nErrors:\n"
                + "\n".join(result["errors"])
            )

        elif name == "git_log":
            return _git_log(work_dir)

        elif name == "task_done":
            # TRUST PILLAR 4: Quality gate — block task_done if verification fails
            written_paths = [c["path"] for c in ctx["code_changes"]]
            if written_paths:
                verify_result = _auto_verify(work_dir, written_paths)
                _broadcast_ws({
                    "type": "verification_result",
                    "agent": "swe_agent",
                    "passed": verify_result["passed"],
                    "summary": verify_result["summary"],
                    "errors": verify_result["errors"],
                })
                if not verify_result["passed"]:
                    return (
                        f"BLOCKED — task_done requires passing verification.\n"
                        f"{verify_result['summary']}\n\nErrors:\n"
                        + "\n".join(verify_result["errors"])
                        + "\n\nFix the errors above and call verify() before task_done()."
                    )
            # All clear — mark done
            ctx["done"] = True
            ctx["done_summary"] = args.get("summary", "Task complete.")
            # TRUST PILLAR 2: Single commit for entire task (not per-file — avoids subprocess overhead)
            if git_available and written_paths:
                final_hash = _git_commit(work_dir, ctx["done_summary"][:72])
                _broadcast_ws({
                    "type": "git_commit", "agent": "swe_agent",
                    "hash": final_hash, "message": ctx["done_summary"][:72],
                })
            return "Task marked done."

        return f"Unknown tool: {name}"

    # ── System prompt ──────────────────────────────────────────────────────
    tree_text = _workspace_tree_text(str(work_dir))
    plan_text = "\n".join(f"  {i+1}. {s}" for i, s in enumerate(state.get("execution_plan", [])))

    # Compact task summary instead of full JSON dump
    raw_tasks = state.get("decomposed_tasks", [])
    tasks_summary = "\n".join(
        f"  - {t.get('function_name', 'task')}: {t.get('purpose', '')}"
        for t in raw_tasks[:10]
    ) or "  (none)"

    git_note = (
        "Git is ACTIVE — all changes committed atomically at task_done. "
        "Use git_log() to see prior commits."
        if git_available else
        "Git not available — changes are not versioned."
    )

    system_prompt = f"""You are SWE-Agent, an autonomous software engineer. Be FAST and DIRECT.

{_detect_shell_env(work_dir)}

WORKSPACE:
{tree_text}

USER TASK: {state["user_prompt"]}

PLAN:
{plan_text or "  (derive from task)"}

SUBTASKS:
{tasks_summary}

REVERSIBILITY: {git_note}

STRATEGY — SPEED IS CRITICAL:
1. Write COMPLETE files with write_file(). Write ALL code for a file in ONE call.
2. Do NOT read files you just wrote — you know the content.
3. Only read_file() for EXISTING files you need to modify.
4. Install deps with run_bash() ONCE (combine: "pip install x y z").
5. Call verify() ONCE after all files are written — fix any errors it reports.
6. Call task_done() ONLY after verify() passes. It is blocked otherwise.

RULES:
• write_file() = full file content. Use for new files (most cases).
• edit_file() = surgical replace. ONLY for modifying existing files you already read.
• verify() = syntax + test check. REQUIRED before task_done().
• task_done() = BLOCKED if verify() fails. Fix errors first.
• No stubs, no TODO, no placeholders — write production-ready code.
• Do NOT narrate your thinking. Just call tools.
• Combine related work — write ALL functions in a file in one write_file() call."""

    # ── Initialize conversation ────────────────────────────────────────────
    history = [
        _gt.Content(
            role="user",
            parts=[_gt.Part(text="Implement now. Write complete files directly — no exploration needed for new projects.")],
        )
    ]

    # ── Read-only tools (safe for parallel execution) ───────────────────
    READ_ONLY_TOOLS = {"read_file", "list_dir", "search_code"}

    # ── History compaction — prune old tool results to keep context lean ──
    COMPACT_EVERY = 4  # Compact after every N steps

    def _compact_history():
        """Replace old tool result contents with short summaries."""
        # Keep last 3 user turns (tool responses) intact, compact everything older
        user_turn_count = 0
        for i in range(len(history) - 1, -1, -1):
            entry = history[i]
            if entry.role == "user" and any(hasattr(p, 'function_response') and p.function_response for p in (entry.parts or [])):
                user_turn_count += 1
                if user_turn_count > 3:
                    # Compact this old tool response — replace with summary
                    compacted_parts = []
                    for p in entry.parts:
                        if hasattr(p, 'function_response') and p.function_response:
                            fr = p.function_response
                            result_text = fr.response.get("result", "") if fr.response else ""
                            # Truncate to first 200 chars
                            short = result_text[:200] + "..." if len(result_text) > 200 else result_text
                            compacted_parts.append(_gt.Part(
                                function_response=_gt.FunctionResponse(
                                    name=fr.name,
                                    response={"result": short},
                                )
                            ))
                        else:
                            compacted_parts.append(p)
                    history[i] = _gt.Content(role="user", parts=compacted_parts)

    # ── Loop ──────────────────────────────────────────────────────────────
    steps_taken = 0
    for step in range(MAX_AGENT_STEPS):
        steps_taken = step + 1

        if ctx["done"] or ctx["hitl_required"]:
            break

        # Compact history periodically
        if step > 0 and step % COMPACT_EVERY == 0:
            _compact_history()

        _rate_limiter.acquire()  # respect 15 req/min API limit
        text, func_calls, model_content = call_llm_with_tools_turn(
            MODEL, system_prompt, history, tool_decls, state["google_api_key"]
        )

        # Stream reasoning — only short status lines, skip verbose self-talk
        if text.strip():
            lines = [l.strip() for l in text.strip().split('\n') if l.strip()]
            useful = [l for l in lines if len(l) < 150 and not l.startswith(('I ', 'Let me ', 'Now I ', "I'll ", 'I need ', 'I should ', 'Okay', 'Wait', 'Actually', 'Hmm'))]
            if useful:
                _broadcast_ws({"type": "agent_token", "agent": "swe_agent", "text": '\n'.join(useful)})

        # Append model turn to history
        history.append(model_content)

        if not func_calls:
            ctx["done"] = True
            ctx["done_summary"] = text[:400]
            break

        # ── Execute tools — parallel for read-only, sequential for mutating ──
        tool_responses: list[tuple[str, str]] = []

        # Separate read-only vs mutating calls
        read_calls = [fc for fc in func_calls if fc["name"] in READ_ONLY_TOOLS]
        write_calls = [fc for fc in func_calls if fc["name"] not in READ_ONLY_TOOLS]

        # Execute read-only tools in parallel (if multiple)
        if len(read_calls) > 1:
            import concurrent.futures
            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                futures = {pool.submit(_exec, fc["name"], fc["args"]): fc for fc in read_calls}
                for fut in concurrent.futures.as_completed(futures):
                    fc = futures[fut]
                    tool_responses.append((fc["name"], fut.result()))
        elif read_calls:
            fc = read_calls[0]
            tool_responses.append((fc["name"], _exec(fc["name"], fc["args"])))

        # Execute mutating tools sequentially
        for fc in write_calls:
            if ctx["hitl_required"] or ctx["done"]:
                break
            result_text = _exec(fc["name"], fc["args"])
            tool_responses.append((fc["name"], result_text))

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
