export type AgentName = "codeplan" | "parsel" | "swe_agent" | "autocoderover" | "orchestrator";
export type AgentState = "idle" | "working" | "error" | "waiting_approval" | "complete";

export interface TelemetryPacket {
  type?: "agent_transition" | "hitl_required" | "pipeline_done" | "pipeline_error" | "step_complete";
  agent: AgentName;
  state: AgentState;
  message: string;
  timestamp?: string;
  step?: number;
  hitl_type?: "file_overwrite" | "vulnerability_found";
  payload?: Record<string, unknown>;
}

export interface SessionStatus {
  session_id: string;
  current_agent: AgentName;
  step_count: number;
  status: "running" | "hitl_pause" | "complete" | "error";
}
