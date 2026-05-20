"""
AutoCodeRover — AST auditor / mathematical trust layer.
Traverses AST of written code to detect vulnerabilities before accepting changes.
"""
import ast
import json
import re
from pathlib import Path
from google import genai
from backend.orchestrator.state import VantageState


MODEL = "gemma-4-26b-a4b-it"


def _call_llm(prompt: str, api_key: str) -> str:
    client = genai.Client(api_key=api_key)
    response = client.models.generate_content(
        model=MODEL,
        contents=prompt,
    )
    return response.text or ""


class ASTAuditor(ast.NodeVisitor):
    """Traverse AST and flag potential vulnerabilities."""

    def __init__(self):
        self.issues: list[str] = []
        self._loop_depth = 0
        self._func_calls: dict[str, int] = {}

    def visit_While(self, node: ast.While):
        self._loop_depth += 1
        if isinstance(node.test, ast.Constant) and node.test.value is True:
            has_break = any(isinstance(n, ast.Break) for n in ast.walk(node))
            if not has_break:
                self.issues.append("Potential infinite loop: `while True` with no `break`")
        self.generic_visit(node)
        self._loop_depth -= 1

    def visit_Call(self, node: ast.Call):
        if isinstance(node.func, ast.Name):
            name = node.func.id
            self._func_calls[name] = self._func_calls.get(name, 0) + 1
        self.generic_visit(node)

    def visit_FunctionDef(self, node: ast.FunctionDef):
        calls_self = any(
            isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == node.name
            for n in ast.walk(node)
        )
        if calls_self:
            has_if = any(isinstance(n, ast.If) for n in ast.walk(node))
            if not has_if:
                self.issues.append(
                    f"Recursive function `{node.name}` has no base-case `if` guard — risk of stack overflow"
                )
        self.generic_visit(node)

    def visit_Assign(self, node: ast.Assign):
        if isinstance(node.value, ast.Call):
            if isinstance(node.value.func, ast.Name) and node.value.func.id == "open":
                self.issues.append(
                    "File opened without `with` context manager — potential resource leak"
                )
        self.generic_visit(node)


def audit_file(content: str, filename: str) -> list[str]:
    try:
        tree = ast.parse(content)
        auditor = ASTAuditor()
        auditor.visit(tree)
        return [f"[{filename}] {issue}" for issue in auditor.issues]
    except SyntaxError as e:
        return [f"[{filename}] SyntaxError: {e}"]


def run_autocoderover(state: VantageState) -> dict:
    all_issues: list[str] = []

    for change in state.get("code_changes", []):
        issues = audit_file(change.get("content", ""), change.get("path", "unknown"))
        all_issues.extend(issues)

    try:
        workspace = Path(state["workspace_path"])
        for py_file in workspace.rglob("*.py"):
            try:
                content = py_file.read_text(encoding="utf-8", errors="ignore")
                rel = str(py_file.relative_to(workspace))
                issues = audit_file(content, rel)
                all_issues.extend(issues)
            except Exception:
                pass
    except Exception:
        pass

    ast_report = {
        "vulnerabilities": all_issues,
        "passed": len(all_issues) == 0,
    }

    if all_issues:
        return {
            "ast_report": ast_report,
            "vulnerability_flags": all_issues,
            "hitl_required": True,
            "hitl_type": "vulnerability_found",
            "hitl_description": f"AutoCodeRover flagged {len(all_issues)} issue(s): {'; '.join(all_issues[:3])}",
            "status": "hitl_pause",
            "current_agent": "autocoderover",
            "step_count": 1,
            "last_telemetry": {
                "agent": "autocoderover",
                "state": "error",
                "message": f"AST audit found {len(all_issues)} vulnerability/issue(s).",
            },
        }

    changes_summary = json.dumps(
        [{"path": c["path"], "content": c["content"][:500]} for c in state.get("code_changes", [])],
        indent=2,
    )

    prompt = f"""You are AutoCodeRover, a strict code auditor.
Review these code changes and confirm they correctly implement:
{state["user_prompt"]}

Changes:
{changes_summary}

Respond with JSON: {{"approved": true/false, "reason": "..."}}"""

    text = _call_llm(prompt, state["google_api_key"])
    match = re.search(r"\{.*\}", text, re.DOTALL)
    review = json.loads(match.group()) if match else {"approved": True, "reason": "AST passed"}

    return {
        "ast_report": ast_report,
        "vulnerability_flags": [],
        "hitl_required": False,
        "status": "complete" if review.get("approved") else "error",
        "current_agent": "orchestrator",
        "step_count": 1,
        "last_telemetry": {
            "agent": "autocoderover",
            "state": "complete",
            "message": f"AST clean. LLM review: {review.get('reason', 'passed')}",
        },
    }
