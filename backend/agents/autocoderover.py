"""
AutoCodeRover — language-agnostic code auditor.

Strategy (same as Claude Code / Codex):
  1. Heuristic scan: secrets, dangerous patterns — all file types.
  2. LLM deep review: full file contents sent to model, asked for
     issues + corrected code where needed.
  3. Apply LLM-suggested patches back to project_dir files.
  4. HITL only when heuristics flag critical issues.
"""
import json
import re
import os
from pathlib import Path
from backend.orchestrator.state import VantageState
from backend.agents.utils import call_llm
from backend.broadcast import broadcast as _broadcast_ws

MODEL = "gemma-4-26b-a4b-it"

# ── Heuristic patterns (language-agnostic) ─────────────────────────────────
_CRITICAL_PATTERNS = [
    # Secrets / credentials
    (r'(?i)(password|secret|api_key|token)\s*=\s*["\'][^"\']{4,}["\']',
     "Hardcoded credential detected"),
    # SQL injection sinks
    (r'(?i)execute\s*\(\s*f["\']|\.format\s*\(.*SELECT|%\s*\(.*SELECT',
     "Potential SQL injection via string formatting"),
    # Shell injection
    (r'(?i)os\.system\s*\(|subprocess\.(call|run|Popen)\s*\(.*shell\s*=\s*True',
     "Shell injection risk — shell=True with user input"),
    # Path traversal
    (r'\.\./',
     "Potential path traversal"),
    # Infinite loop without break (simple heuristic)
    (r'while\s+[Tt]rue\s*[:{](?!.*break)',
     "Possible infinite loop — while True with no break visible"),
]

# Max chars of file content sent to LLM per file
_MAX_FILE_CHARS = 3000
# Max files reviewed by LLM in one pass
_MAX_LLM_FILES = 10


def _on_chunk(text: str):
    _broadcast_ws({"type": "agent_token", "agent": "autocoderover", "text": text})


def _call_llm(prompt: str, api_key: str) -> str:
    return call_llm(MODEL, prompt, api_key, on_chunk=_on_chunk)


def _heuristic_scan(files: list[dict]) -> list[str]:
    """Fast regex scan across all written files regardless of language."""
    findings = []
    for f in files:
        content = f.get("content", "")
        path = f.get("path", "unknown")
        for pattern, label in _CRITICAL_PATTERNS:
            if re.search(pattern, content):
                findings.append(f"[{path}] {label}")
    return findings


def _build_review_prompt(user_prompt: str, files: list[dict]) -> str:
    files_block = ""
    for f in files[:_MAX_LLM_FILES]:
        ext = Path(f["path"]).suffix.lstrip(".")
        content = f["content"][:_MAX_FILE_CHARS]
        truncated = "... (truncated)" if len(f["content"]) > _MAX_FILE_CHARS else ""
        files_block += f'\n### {f["path"]}\n```{ext}\n{content}{truncated}\n```\n'

    return f"""You are AutoCodeRover, a senior code reviewer working across any programming language.

Task the code is meant to solve:
{user_prompt}

Files written:
{files_block}

Review the code thoroughly. For each file:
- Check correctness: does it solve the task?
- Check bugs: off-by-one, null refs, type errors, logic errors.
- Check security: injections, hardcoded secrets, path traversal.
- Check quality: resource leaks, missing error handling.

If any file needs changes, output the FULL corrected content.

Respond ONLY with valid JSON, no markdown fences:
{{
  "approved": true,
  "issues": ["issue 1", "issue 2"],
  "patches": [
    {{
      "path": "relative/file.ext",
      "corrected_content": "full corrected file content here"
    }}
  ],
  "summary": "one sentence summary of review"
}}

If code is correct, return approved=true, empty patches array.
If fixes were needed, return approved=true after applying patches, list issues found."""


def _apply_patches(patches: list[dict], work_dir: str) -> list[str]:
    """Write corrected file contents back to disk. Returns list of patched paths."""
    patched = []
    root = Path(work_dir)
    for p in patches:
        file_path = root / p["path"]
        content = p.get("corrected_content", "")
        if content:
            try:
                file_path.parent.mkdir(parents=True, exist_ok=True)
                file_path.write_text(content, encoding="utf-8")
                patched.append(p["path"])
            except Exception:
                pass
    return patched


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


def run_autocoderover(state: VantageState) -> dict:
    code_changes = state.get("code_changes", [])
    work_dir = state.get("project_dir") or state["workspace_path"]

    # ── Phase 1: fast heuristic scan ──────────────────────────────────────
    critical_flags = _heuristic_scan(code_changes)

    # ── Phase 2: LLM deep review ───────────────────────────────────────────
    review = {"approved": True, "issues": [], "patches": [], "summary": "Passed."}

    if code_changes:
        prompt = _build_review_prompt(state["user_prompt"], code_changes)
        raw = _call_llm(prompt, state["google_api_key"])

        # Strip markdown fences if model wraps response
        clean = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw.strip(), flags=re.DOTALL)
        match = re.search(r"\{.*\}", clean, re.DOTALL)
        if match:
            try:
                review = json.loads(match.group())
            except json.JSONDecodeError:
                pass

    # ── Phase 3: apply LLM patches ─────────────────────────────────────────
    patches = review.get("patches", [])
    patched_paths = []
    if patches:
        patched_paths = _apply_patches(patches, work_dir)
        # Broadcast updated files
        for p in patches:
            if p["path"] in patched_paths:
                _broadcast_ws({
                    "type": "file_write",
                    "path": p["path"],
                    "content": p.get("corrected_content", ""),
                })
        _broadcast_ws({
            "type": "file_tree",
            "tree": _build_tree(work_dir, work_dir),
        })

    # ── Phase 4: HITL only for critical heuristic hits ─────────────────────
    skip_hitl = state.get("hitl_approved") is True
    if not skip_hitl and critical_flags:
        return {
            "ast_report": {"vulnerabilities": critical_flags, "passed": False},
            "vulnerability_flags": critical_flags,
            "hitl_required": True,
            "hitl_type": "vulnerability_found",
            "hitl_description": (
                f"AutoCodeRover flagged {len(critical_flags)} critical issue(s): "
                f"{'; '.join(critical_flags[:3])}"
            ),
            "status": "hitl_pause",
            "current_agent": "autocoderover",
            "step_count": 1,
            "last_telemetry": {
                "agent": "autocoderover",
                "state": "waiting_approval",
                "message": f"Critical issues detected: {critical_flags[0]}",
            },
        }

    # ── Done ───────────────────────────────────────────────────────────────
    all_issues = critical_flags + review.get("issues", [])
    summary = review.get("summary", "Review complete.")
    if patched_paths:
        summary += f" Auto-patched: {', '.join(patched_paths)}."

    return {
        "ast_report": {"vulnerabilities": all_issues, "passed": len(all_issues) == 0},
        "vulnerability_flags": all_issues,
        "hitl_required": False,
        "hitl_approved": None,
        "status": "complete",
        "current_agent": "orchestrator",
        "step_count": 1,
        "last_telemetry": {
            "agent": "autocoderover",
            "state": "complete",
            "message": summary,
        },
    }
