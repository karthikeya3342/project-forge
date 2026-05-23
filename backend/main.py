import asyncio
import json
import os
import uuid

# Patch Python SSL to use certifi CA bundle — fixes Windows cert chain issues with httpx/requests
import ssl
import certifi

os.environ['SSL_CERT_FILE'] = certifi.where()
os.environ['REQUESTS_CA_BUNDLE'] = certifi.where()

_orig_create_default_context = ssl.create_default_context
def _patched_create_default_context(purpose=ssl.Purpose.SERVER_AUTH, *args, **kwargs):
    ctx = _orig_create_default_context(purpose, *args, **kwargs)
    ctx.load_verify_locations(certifi.where())
    return ctx
ssl.create_default_context = _patched_create_default_context
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Set

import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from backend.db.database import init_db, SessionLocal
from backend.db.models import AgentSession, HITLCheckpoint
from backend.orchestrator.graph import build_graph
from backend.broadcast import set_broadcast
from langgraph.checkpoint.memory import MemorySaver

load_dotenv()

# ── Module-level checkpointer + graph (shared so HITL resume works) ────────
_checkpointer = MemorySaver()
_graph = None  # built after lifespan sets broadcast

# Running pipeline tasks keyed by session_id (for cancellation)
_running_tasks: dict[str, asyncio.Task] = {}


def get_graph():
    global _graph
    if _graph is None:
        _graph = build_graph(checkpointer=_checkpointer)
    return _graph


# ── WebSocket connection registry ──────────────────────────────────────────
active_connections: Set[WebSocket] = set()


async def broadcast_telemetry(message: str):
    dead = set()
    for ws in active_connections:
        try:
            await ws.send_text(message)
        except Exception:
            dead.add(ws)
    active_connections.difference_update(dead)


# ── App lifecycle ──────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    os.makedirs("data", exist_ok=True)
    init_db()
    loop = asyncio.get_running_loop()
    set_broadcast(broadcast_telemetry, loop)
    yield


app = FastAPI(title="VANTAGE Backend", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:3001", "http://localhost:3002", "http://localhost:3003"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Pydantic schemas ───────────────────────────────────────────────────────
class StartRequest(BaseModel):
    prompt: str
    workspace_path: str
    google_api_key: str


class HITLResponse(BaseModel):
    session_id: str
    approved: bool


class PlanApprovalRequest(BaseModel):
    session_id: str
    approved: bool = True


class FileWriteRequest(BaseModel):
    path: str
    content: str


# ── Routes ─────────────────────────────────────────────────────────────────
@app.post("/api/start")
async def start_pipeline(req: StartRequest):
    workspace = Path(req.workspace_path)
    if not workspace.exists():
        return {"error": f"Workspace path does not exist: {req.workspace_path}"}

    session_id = str(uuid.uuid4())

    db = SessionLocal()
    try:
        session = AgentSession(
            session_id=session_id,
            user_prompt=req.prompt,
            workspace_path=req.workspace_path,
            status="running",
        )
        db.add(session)
        db.commit()
    finally:
        db.close()

    initial_state = {
        "session_id": session_id,
        "user_prompt": req.prompt,
        "workspace_path": req.workspace_path,
        "google_api_key": req.google_api_key,
        "file_dependency_map": {},
        "execution_plan": [],
        "decomposed_tasks": [],
        "code_changes": [],
        "last_command_output": "",
        "last_error": None,
        "ast_report": {},
        "vulnerability_flags": [],
        "step_count": 0,
        "current_agent": "codeplan",
        "status": "running",
        "plan_approved": None,
        "hitl_required": False,
        "hitl_type": None,
        "hitl_description": None,
        "hitl_approved": None,
        "project_dir": None,
        "last_telemetry": {},
    }

    graph = get_graph()

    # Run pipeline in background task — store ref for cancellation
    task = asyncio.create_task(_run_pipeline(graph, initial_state, session_id))
    _running_tasks[session_id] = task
    task.add_done_callback(lambda _: _running_tasks.pop(session_id, None))

    return {"session_id": session_id, "status": "started"}


async def _run_pipeline(graph, state: dict, session_id: str):
    try:
        config = {"configurable": {"thread_id": session_id}}
        async for event in graph.astream(state, config=config):
            db = SessionLocal()
            try:
                session = db.query(AgentSession).filter_by(session_id=session_id).first()
                if session:
                    current_state = graph.get_state(config)
                    vals = current_state.values if current_state else {}
                    session.set_state(dict(vals) if vals else {})
                    session.current_agent = vals.get("current_agent", "unknown") if vals else "unknown"
                    session.step_count = vals.get("step_count", 0) if vals else 0
                    session.status = vals.get("status", "running") if vals else "running"
                    db.commit()
            finally:
                db.close()
    except Exception as e:
        await broadcast_telemetry(json.dumps({
            "type": "pipeline_error",
            "agent": "orchestrator",
            "state": "error",
            "message": str(e),
        }))


@app.post("/api/approve-plan")
async def approve_plan(req: PlanApprovalRequest):
    """Resume graph after user reviews and approves (or rejects) the execution plan."""
    graph = get_graph()
    config = {"configurable": {"thread_id": req.session_id}}

    graph.update_state(config, {
        "plan_approved": req.approved,
        "status": "running" if req.approved else "error",
    })
    asyncio.create_task(_resume_pipeline(graph, config, req.session_id))
    return {"session_id": req.session_id, "approved": req.approved}


@app.post("/api/approve")
async def approve_hitl(req: HITLResponse):
    graph = get_graph()
    config = {"configurable": {"thread_id": req.session_id}}

    # Resume graph with approval
    graph.update_state(config, {"hitl_approved": req.approved, "hitl_required": False, "status": "running"})
    asyncio.create_task(_resume_pipeline(graph, config, req.session_id))

    return {"session_id": req.session_id, "approved": req.approved}


async def _resume_pipeline(graph, config: dict, session_id: str):
    try:
        async for _ in graph.astream(None, config=config):
            pass
    except Exception as e:
        await broadcast_telemetry(json.dumps({
            "type": "pipeline_error",
            "agent": "orchestrator",
            "state": "error",
            "message": str(e),
        }))


@app.post("/api/stop/{session_id}")
async def stop_pipeline(session_id: str):
    task = _running_tasks.get(session_id)
    if task and not task.done():
        task.cancel()

    db = SessionLocal()
    try:
        session = db.query(AgentSession).filter_by(session_id=session_id).first()
        if session:
            session.status = "stopped"
            db.commit()
    finally:
        db.close()

    await broadcast_telemetry(json.dumps({
        "type": "pipeline_error",
        "agent": "orchestrator",
        "state": "error",
        "message": "Pipeline stopped by user.",
    }))
    return {"session_id": session_id, "status": "stopped"}


@app.get("/api/status/{session_id}")
async def get_status(session_id: str):
    db = SessionLocal()
    try:
        session = db.query(AgentSession).filter_by(session_id=session_id).first()
    finally:
        db.close()
    if not session:
        return {"error": "Session not found"}
    return {
        "session_id": session.session_id,
        "current_agent": session.current_agent,
        "step_count": session.step_count,
        "status": session.status,
    }


@app.get("/api/workspace-tree")
async def workspace_tree(path: str):
    import os
    root = path

    def _build(p: str) -> list:
        result = []
        try:
            for entry in sorted(os.scandir(p), key=lambda e: (not e.is_dir(), e.name)):
                rel = os.path.relpath(entry.path, root)
                node = {
                    "path": rel.replace("\\", "/"),
                    "name": entry.name,
                    "type": "directory" if entry.is_dir() else "file",
                }
                if entry.is_dir():
                    node["children"] = _build(entry.path)
                result.append(node)
        except Exception:
            pass
        return result

    if not os.path.isdir(root):
        return {"error": f"Not a directory: {root}", "tree": []}
    return {"tree": _build(root)}


@app.get("/api/browse-folder")
async def browse_folder():
    """Open native OS folder picker dialog, return selected path."""
    import tkinter as tk
    from tkinter import filedialog
    try:
        root = tk.Tk()
        root.withdraw()
        root.wm_attributes('-topmost', True)
        path = filedialog.askdirectory(title="Select Workspace Folder")
        root.destroy()
        return {"path": path.replace("/", "\\") if path else ""}
    except Exception as e:
        return {"path": "", "error": str(e)}


@app.get("/api/file")
async def read_file_content(path: str):
    """Read file content from disk."""
    try:
        file_path = Path(path)
        if not file_path.exists() or not file_path.is_file():
            return {"content": "", "error": f"File not found: {path}"}
        content = file_path.read_text(encoding="utf-8", errors="replace")
        return {"content": content}
    except Exception as e:
        return {"content": "", "error": str(e)}


@app.post("/api/file")
async def write_file_content(req: FileWriteRequest):
    """Write file content to disk (editor save)."""
    try:
        file_path = Path(req.path)
        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_path.write_text(req.content, encoding="utf-8")
        return {"success": True}
    except Exception as e:
        return {"success": False, "error": str(e)}


# ── WebSocket — telemetry broadcast ───────────────────────────────────────
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    active_connections.add(websocket)
    try:
        while True:
            await websocket.receive_text()  # keep connection alive
    except WebSocketDisconnect:
        active_connections.discard(websocket)


# ── WebSocket — integrated terminal ───────────────────────────────────────
@app.websocket("/ws/terminal")
async def terminal_ws(websocket: WebSocket):
    """
    Persistent command-by-command terminal session.
    Client sends: {"type": "init", "cwd": "..."} | {"type": "command", "command": "..."}
    Server sends: {"type": "output", "text": "..."} | {"type": "done", "returncode": N} | {"type": "cwd", "path": "..."}
    """
    await websocket.accept()
    import platform

    cwd: str = os.getcwd()

    async def _stream_command(cmd: str) -> None:
        nonlocal cwd
        # Handle cd specially so directory persists across commands
        if cmd.startswith("cd ") or cmd == "cd":
            target = cmd[3:].strip() if cmd.startswith("cd ") else ""
            if not target or target == "~":
                new_dir = str(Path.home())
            else:
                new_dir = str(Path(cwd) / target)
            try:
                new_dir = str(Path(new_dir).resolve())
                if Path(new_dir).is_dir():
                    cwd = new_dir
                    await websocket.send_text(json.dumps({"type": "cwd", "path": cwd}))
                    await websocket.send_text(json.dumps({"type": "done", "returncode": 0}))
                else:
                    await websocket.send_text(json.dumps({
                        "type": "output", "text": f"cd: {target}: No such directory\n"
                    }))
                    await websocket.send_text(json.dumps({"type": "done", "returncode": 1}))
            except Exception as e:
                await websocket.send_text(json.dumps({"type": "output", "text": f"cd error: {e}\n"}))
                await websocket.send_text(json.dumps({"type": "done", "returncode": 1}))
            return

        # Run command as subprocess, stream output
        try:
            shell = True
            if platform.system() == "Windows":
                proc = await asyncio.create_subprocess_shell(
                    cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.STDOUT,
                    cwd=cwd,
                )
            else:
                proc = await asyncio.create_subprocess_shell(
                    cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.STDOUT,
                    cwd=cwd,
                    executable="/bin/bash",
                )

            while True:
                chunk = await proc.stdout.read(2048)
                if not chunk:
                    break
                text = chunk.decode("utf-8", errors="replace")
                await websocket.send_text(json.dumps({"type": "output", "text": text}))

            returncode = await proc.wait()
            await websocket.send_text(json.dumps({"type": "done", "returncode": returncode}))
        except Exception as e:
            await websocket.send_text(json.dumps({"type": "output", "text": f"Error: {e}\n"}))
            await websocket.send_text(json.dumps({"type": "done", "returncode": 1}))

    try:
        while True:
            raw = await websocket.receive_text()
            data = json.loads(raw)
            msg_type = data.get("type")

            if msg_type == "init":
                init_cwd = data.get("cwd", "")
                if init_cwd and Path(init_cwd).is_dir():
                    cwd = str(Path(init_cwd).resolve())
                await websocket.send_text(json.dumps({"type": "cwd", "path": cwd}))
                await websocket.send_text(json.dumps({
                    "type": "output",
                    "text": f"Terminal ready\n",
                }))

            elif msg_type == "command":
                cmd = data.get("command", "").strip()
                if cmd:
                    await _stream_command(cmd)

    except WebSocketDisconnect:
        pass
    except Exception:
        pass


if __name__ == "__main__":
    uvicorn.run("backend.main:app", host="0.0.0.0", port=8000, reload=True)
