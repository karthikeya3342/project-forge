import asyncio
import json
import os
import uuid
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
from backend.orchestrator.graph import build_graph, set_broadcast
from langgraph.checkpoint.sqlite import SqliteSaver

load_dotenv()

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
    set_broadcast(broadcast_telemetry)
    yield


app = FastAPI(title="VANTAGE Backend", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
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


# ── Routes ─────────────────────────────────────────────────────────────────
@app.post("/api/start")
async def start_pipeline(req: StartRequest):
    workspace = Path(req.workspace_path)
    if not workspace.exists():
        return {"error": f"Workspace path does not exist: {req.workspace_path}"}

    session_id = str(uuid.uuid4())

    db = SessionLocal()
    session = AgentSession(
        session_id=session_id,
        user_prompt=req.prompt,
        workspace_path=req.workspace_path,
        status="running",
    )
    db.add(session)
    db.commit()
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
        "hitl_required": False,
        "hitl_type": None,
        "hitl_description": None,
        "hitl_approved": None,
        "last_telemetry": {},
    }

    checkpointer = SqliteSaver.from_conn_string("data/vantage.db")
    graph = build_graph(checkpointer=checkpointer)

    # Run pipeline in background task
    asyncio.create_task(_run_pipeline(graph, initial_state, session_id))

    return {"session_id": session_id, "status": "started"}


async def _run_pipeline(graph, state: dict, session_id: str):
    try:
        config = {"configurable": {"thread_id": session_id}}
        async for event in graph.astream(state, config=config):
            db = SessionLocal()
            session = db.query(AgentSession).filter_by(session_id=session_id).first()
            if session:
                current_state = graph.get_state(config)
                session.set_state(dict(current_state.values) if current_state.values else {})
                session.current_agent = current_state.values.get("current_agent", "unknown") if current_state.values else "unknown"
                session.step_count = current_state.values.get("step_count", 0) if current_state.values else 0
                session.status = current_state.values.get("status", "running") if current_state.values else "running"
                db.commit()
            db.close()
    except Exception as e:
        await broadcast_telemetry(json.dumps({
            "type": "pipeline_error",
            "agent": "orchestrator",
            "state": "error",
            "message": str(e),
        }))


@app.post("/api/approve")
async def approve_hitl(req: HITLResponse):
    checkpointer = SqliteSaver.from_conn_string("data/vantage.db")
    graph = build_graph(checkpointer=checkpointer)
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


@app.get("/api/status/{session_id}")
async def get_status(session_id: str):
    db = SessionLocal()
    session = db.query(AgentSession).filter_by(session_id=session_id).first()
    db.close()
    if not session:
        return {"error": "Session not found"}
    return {
        "session_id": session.session_id,
        "current_agent": session.current_agent,
        "step_count": session.step_count,
        "status": session.status,
    }


# ── WebSocket ──────────────────────────────────────────────────────────────
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    active_connections.add(websocket)
    try:
        while True:
            await websocket.receive_text()  # keep connection alive
    except WebSocketDisconnect:
        active_connections.discard(websocket)


if __name__ == "__main__":
    uvicorn.run("backend.main:app", host="0.0.0.0", port=8000, reload=True)
