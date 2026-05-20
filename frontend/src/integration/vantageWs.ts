/**
 * VANTAGE WebSocket bridge.
 *
 * Receives backend telemetry and drives:
 * 1. agentStatuses (animates 3D characters)
 * 2. coreStore tasks (populates Kanban with pipeline steps)
 * 3. coreStore phase (working → done/error)
 * 4. vantageHitl (triggers HITL approval overlay)
 */
import { useUiStore } from './store/uiStore';
import { useCoreStore } from './store/coreStore';
import type { AgentState } from '../types';

// Backend agent name → 3D character index
const AGENT_INDEX: Record<string, number> = {
  orchestrator:   1,
  codeplan:       2,
  parsel:         3,
  swe_agent:      4,
  autocoderover:  5,
};

// Backend agent name → display label
const AGENT_LABEL: Record<string, string> = {
  orchestrator:   'Orchestrator',
  codeplan:       'CodePlan',
  parsel:         'Parsel',
  swe_agent:      'SWE-Agent',
  autocoderover:  'AutoCodeRover',
};

// Active task IDs per agent (so we can update them)
const activeTaskIds: Record<string, string> = {};

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

      const ui = useUiStore.getState() as any;
      const core = useCoreStore.getState();
      const agentName = packet.agent ?? '';
      const agentIdx = AGENT_INDEX[agentName];
      const label = AGENT_LABEL[agentName] ?? agentName;

      // 1. Drive 3D character animation
      if (agentIdx !== undefined) {
        ui.setAgentStatus(agentIdx, STATE_MAP[packet.state ?? 'idle'] ?? 'idle');
      }

      // 2. Append to action log
      if (packet.message && agentName) {
        core.addLogEntry({
          agentIndex: agentIdx ?? 0,
          action: `[${packet.state?.toUpperCase()}] ${packet.message}`,
        });
      }

      // 3. Drive Kanban tasks per agent
      if (agentIdx !== undefined && packet.state) {
        switch (packet.state) {
          case 'working': {
            // Create task for this agent if not already running
            if (!activeTaskIds[agentName]) {
              const task = core.addTask({
                title: `${label}: ${packet.message?.slice(0, 60) ?? 'Working...'}`,
                description: packet.message ?? '',
                assignedAgentId: agentIdx,
                status: 'in_progress',
                requiresUserApproval: false,
              });
              activeTaskIds[agentName] = task.id;
            }
            break;
          }
          case 'complete': {
            const taskId = activeTaskIds[agentName];
            if (taskId) {
              core.setTaskOutput(taskId, packet.message ?? 'Done.');
              core.approveTask(taskId);
              delete activeTaskIds[agentName];
            }
            break;
          }
          case 'error': {
            const taskId = activeTaskIds[agentName];
            if (taskId) {
              core.updateTaskStatus(taskId, 'on_hold');
            }
            break;
          }
          case 'waiting_approval': {
            const taskId = activeTaskIds[agentName];
            if (taskId) {
              core.submitTaskForReview(taskId, packet.message ?? 'Approval required.');
            }
            break;
          }
        }
      }

      // 4. Handle HITL pause
      if (packet.type === 'hitl_required' || packet.state === 'waiting_approval') {
        ui.setVantageHitl({
          type: packet.hitl_type ?? 'unknown',
          description: packet.message ?? 'Agent requires approval.',
        });
      }

      // 5. Pipeline complete
      if (packet.type === 'pipeline_done') {
        Object.keys(activeTaskIds).forEach((name) => delete activeTaskIds[name]);
        Object.values(AGENT_INDEX).forEach((idx) => ui.setAgentStatus(idx, 'idle'));
        core.setPhase('done');
        core.appendAgentHistory(1, 'assistant', [
          '✅ **VANTAGE pipeline complete.** All agents have finished.\n\nCheck your workspace directory for the generated files.'
        ]);
      }

      // 6. Pipeline error
      if (packet.type === 'pipeline_error') {
        Object.values(AGENT_INDEX).forEach((idx) => ui.setAgentStatus(idx, 'idle'));
        core.setPhase('idle');
        core.appendAgentHistory(1, 'assistant', [`❌ Pipeline error: ${packet.message}`]);
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
