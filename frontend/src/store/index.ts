import { create } from "zustand";
import type { AgentName, AgentState, TelemetryPacket } from "../types/telemetry";

export interface AgentInfo {
  name: AgentName;
  state: AgentState;
  message: string;
  label: string;
  color: string;        // hex — used for 3D avatar tint
  position: [number, number, number];
}

const AGENT_DEFAULTS: Record<AgentName, Pick<AgentInfo, "label" | "color" | "position">> = {
  orchestrator: { label: "Orchestrator",    color: "#facc15", position: [0, 0, 0] },
  codeplan:     { label: "CodePlan",        color: "#22d3ee", position: [-4, 0, -2] },
  parsel:       { label: "Parsel",          color: "#a78bfa", position: [-2, 0, 2] },
  swe_agent:    { label: "SWE-Agent",       color: "#fb923c", position: [2, 0, 2] },
  autocoderover:{ label: "AutoCodeRover",   color: "#f472b6", position: [4, 0, -2] },
};

interface AppState {
  // Config
  apiKey: string;
  workspacePath: string;
  configured: boolean;
  setConfig: (apiKey: string, workspacePath: string) => void;

  // Session
  sessionId: string | null;
  pipelineStatus: "idle" | "running" | "hitl_pause" | "complete" | "error";
  stepCount: number;

  // Agents
  agents: Record<AgentName, AgentInfo>;
  updateAgent: (name: AgentName, patch: Partial<AgentInfo>) => void;

  // HITL
  hitlPending: boolean;
  hitlType: string | null;
  hitlDescription: string | null;
  resolveHITL: (approved: boolean) => void;

  // Telemetry log
  log: TelemetryPacket[];
  pushLog: (packet: TelemetryPacket) => void;

  // Actions
  startPipeline: (prompt: string) => Promise<void>;
  setSessionId: (id: string) => void;
  setPipelineStatus: (s: AppState["pipelineStatus"]) => void;
  setHITL: (type: string, description: string) => void;
  clearHITL: () => void;
}

export const useStore = create<AppState>((set, get) => ({
  apiKey: "",
  workspacePath: "",
  configured: false,
  setConfig: (apiKey, workspacePath) => set({ apiKey, workspacePath, configured: true }),

  sessionId: null,
  pipelineStatus: "idle",
  stepCount: 0,

  agents: Object.fromEntries(
    (Object.keys(AGENT_DEFAULTS) as AgentName[]).map((name) => [
      name,
      { name, state: "idle" as AgentState, message: "", ...AGENT_DEFAULTS[name] },
    ])
  ) as Record<AgentName, AgentInfo>,

  updateAgent: (name, patch) =>
    set((s) => ({ agents: { ...s.agents, [name]: { ...s.agents[name], ...patch } } })),

  hitlPending: false,
  hitlType: null,
  hitlDescription: null,

  resolveHITL: async (approved) => {
    const { sessionId } = get();
    if (!sessionId) return;
    await fetch("/api/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, approved }),
    });
    set({ hitlPending: false, hitlType: null, hitlDescription: null, pipelineStatus: "running" });
  },

  log: [],
  pushLog: (packet) =>
    set((s) => ({ log: [...s.log.slice(-199), packet] })),

  startPipeline: async (prompt) => {
    const { apiKey, workspacePath } = get();
    set({ pipelineStatus: "running", log: [] });
    const res = await fetch("/api/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, workspace_path: workspacePath, google_api_key: apiKey }),
    });
    const data = await res.json();
    if (data.session_id) set({ sessionId: data.session_id });
  },

  setSessionId: (id) => set({ sessionId: id }),
  setPipelineStatus: (s) => set({ pipelineStatus: s }),
  setHITL: (type, description) => set({ hitlPending: true, hitlType: type, hitlDescription: description, pipelineStatus: "hitl_pause" }),
  clearHITL: () => set({ hitlPending: false, hitlType: null, hitlDescription: null }),
}));
