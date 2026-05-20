/**
 * VANTAGE WebSocket bridge.
 * Receives backend telemetry and drives the-delegation's existing
 * agent state system (agentStatuses + actionLog) to animate 3D characters.
 */
import { useUiStore } from './store/uiStore';
import { useCoreStore } from './store/coreStore';
import type { AgentState } from '../types';

// Map VANTAGE backend agent names to 3D character indices in the simulation
const AGENT_INDEX: Record<string, number> = {
  orchestrator:   1,
  codeplan:       2,
  parsel:         3,
  swe_agent:      4,
  autocoderover:  5,
};

// Map VANTAGE states to delegation AgentState
const STATE_MAP: Record<string, AgentState> = {
  idle:             'idle',
  working:          'working',
  complete:         'idle',
  error:            'idle',
  waiting_approval: 'on_hold',
};

let socket: WebSocket | null = null;

export function connectVantageWs() {
  if (socket?.readyState === WebSocket.OPEN) return;

  socket = new WebSocket('ws://localhost:8000/ws');

  socket.onopen = () => {
    console.log('[VANTAGE] WebSocket connected');
  };

  socket.onmessage = (event) => {
    try {
      const packet = JSON.parse(event.data as string) as {
        type?: string;
        agent?: string;
        state?: string;
        message?: string;
        hitl_type?: string;
      };

      const ui = useUiStore.getState();
      const core = useCoreStore.getState();

      // Drive 3D character animation state
      if (packet.agent && AGENT_INDEX[packet.agent] !== undefined) {
        const idx = AGENT_INDEX[packet.agent];
        const agentState = STATE_MAP[packet.state ?? 'idle'] ?? 'idle';
        ui.setAgentStatus(idx, agentState);
      }

      // Push to action log (appears in ActionLogPanel)
      if (packet.message && packet.agent) {
        core.addLogEntry({
          agentIndex: AGENT_INDEX[packet.agent] ?? 0,
          action: `[${packet.state?.toUpperCase()}] ${packet.message}`,
        });
      }

      // HITL checkpoint
      if (
        packet.type === 'hitl_required' ||
        packet.state === 'waiting_approval'
      ) {
        ui.setVantageHitl({
          type: packet.hitl_type ?? 'unknown',
          description: packet.message ?? 'Agent requires approval.',
        });
      }

      // Pipeline complete
      if (packet.type === 'pipeline_done') {
        Object.values(AGENT_INDEX).forEach((idx) => {
          ui.setAgentStatus(idx, 'idle');
        });
      }

    } catch {
      // non-JSON — ignore
    }
  };

  socket.onclose = () => {
    console.log('[VANTAGE] WebSocket closed — retrying in 4s');
    setTimeout(connectVantageWs, 4000);
  };

  socket.onerror = () => {
    socket?.close();
  };
}

export function disconnectVantageWs() {
  socket?.close();
  socket = null;
}
