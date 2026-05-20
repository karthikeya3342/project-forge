import json
from datetime import datetime
from sqlalchemy import Column, Integer, String, Text, DateTime, Boolean
from backend.db.database import Base


class AgentSession(Base):
    __tablename__ = "agent_sessions"

    id = Column(Integer, primary_key=True, index=True)
    session_id = Column(String(64), unique=True, index=True)
    user_prompt = Column(Text, nullable=False)
    workspace_path = Column(String(512), nullable=False)
    current_agent = Column(String(64), default="orchestrator")
    step_count = Column(Integer, default=0)
    status = Column(String(32), default="running")  # running|hitl_pause|complete|error
    state_json = Column(Text, default="{}")
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    def get_state(self) -> dict:
        return json.loads(self.state_json)

    def set_state(self, state: dict):
        self.state_json = json.dumps(state)


class HITLCheckpoint(Base):
    __tablename__ = "hitl_checkpoints"

    id = Column(Integer, primary_key=True, index=True)
    session_id = Column(String(64), index=True)
    checkpoint_type = Column(String(64))  # file_overwrite|vulnerability_found
    description = Column(Text)
    payload_json = Column(Text, default="{}")
    resolved = Column(Boolean, default=False)
    approved = Column(Boolean, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
