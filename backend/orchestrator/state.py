from typing import TypedDict, Optional, Annotated
import operator


class VantageState(TypedDict):
    session_id: str
    user_prompt: str
    workspace_path: str
    google_api_key: str

    # CodePlan output
    file_dependency_map: dict
    execution_plan: list[str]

    # Parsel output
    decomposed_tasks: list[dict]

    # SWE-agent output
    code_changes: list[dict]       # [{file, content, action}]
    last_command_output: str
    last_error: Optional[str]

    # AutoCodeRover output
    ast_report: dict               # {vulnerabilities: [...], passed: bool}
    vulnerability_flags: list[str]

    # Orchestrator control
    step_count: Annotated[int, operator.add]
    current_agent: str
    status: str                    # running|hitl_pause|complete|error
    hitl_required: bool
    hitl_type: Optional[str]       # file_overwrite|vulnerability_found
    hitl_description: Optional[str]
    hitl_approved: Optional[bool]

    # Telemetry (broadcast each step)
    last_telemetry: dict
