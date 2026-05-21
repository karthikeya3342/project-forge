/**
 * VANTAGE WebSocket bridge.
 *
 * Receives backend telemetry and drives:
 * 1. vantageStore (file tree, code contents, dep map, console logs)
 * 2. agentStatuses (animates 3D characters)
 * 3. coreStore tasks (populates Kanban with pipeline steps)
 * 4. vantageHitl (triggers HITL approval overlay)
 */
import { useUiStore } from './store/uiStore';
import { useCoreStore } from './store/coreStore';
import { useVantageStore } from './store/vantageStore';
import { isAlwaysAllowed } from './vantageAlwaysAllow';
import { resolveHITL } from './vantageApi';
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
      const raw = event.data as string;
      const packet = JSON.parse(raw) as Record<string, unknown>;

      const ui = useUiStore.getState() as any;
      const core = useCoreStore.getState();
      const vantage = useVantageStore.getState();

      // ── Always append to WS log ──────────────────────────────────────────
      vantage.appendWsLog({ ts: Date.now(), raw, packet });

      const type = packet.type as string | undefined;
      const agentName = (packet.agent as string) ?? '';
      const agentIdx = AGENT_INDEX[agentName];
      const label = AGENT_LABEL[agentName] ?? agentName;
      const state = packet.state as string | undefined;
      const message = packet.message as string | undefined;

      // ── VANTAGE-specific packet types ────────────────────────────────────

      // Streaming token from an agent's LLM call
      if (type === 'agent_token') {
        const chunk = packet.text as string;
        if (chunk) vantage.appendStreamingChunk(agentName || 'agent', chunk);
        return;
      }

      // Tool call event — show which tool SWE-Agent is using
      if (type === 'tool_call') {
        const tool = packet.tool as string;
        const args = packet.args as Record<string, unknown>;
        // Surface as a streaming token so it appears inline in the chat stream
        const argStr = Object.entries(args ?? {})
          .map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 60)}`)
          .join(', ');
        vantage.appendStreamingChunk(agentName || 'swe_agent', `\n🔧 **${tool}**(${argStr})\n`);
        return;
      }

      // File write event: update content cache + mark as modifying
      if (type === 'file_write') {
        const path = packet.path as string;
        const content = packet.content as string;
        vantage.setFileContent(path, content);
        vantage.setModifyingFile(path, true);
        // Clear modifying indicator after 2s
        setTimeout(() => {
          useVantageStore.getState().setModifyingFile(path, false);
        }, 2000);
      }

      // File tree update
      if (type === 'file_tree') {
        const tree = packet.tree as any[];
        vantage.setFileTree(tree);
      }

      // Dependency map update
      if (type === 'dependency_map') {
        const map = packet.map as Record<string, string[]>;
        vantage.setDependencyMap(map);
      }

      // Terminal output
      if (type === 'terminal_output') {
        const output = packet.output as string;
        vantage.appendTerminalLog({ ts: Date.now(), output });
        vantage.setConsoleTab('terminal');
      }

      // Track current pipeline node
      if (agentName && state === 'working') {
        vantage.setCurrentNode(agentName);
      }
      if (type === 'pipeline_done' || type === 'pipeline_error') {
        vantage.setCurrentNode('');
      }

      // ── 3D character animation ───────────────────────────────────────────
      if (agentIdx !== undefined) {
        ui.setAgentStatus(agentIdx, STATE_MAP[state ?? 'idle'] ?? 'idle');
      }

      // ── Action log ───────────────────────────────────────────────────────
      if (message && agentName) {
        core.addLogEntry({
          agentIndex: agentIdx ?? 0,
          action: `[${state?.toUpperCase()}] ${message}`,
        });
      }

      // ── Kanban tasks per agent ───────────────────────────────────────────
      if (agentIdx !== undefined && state) {
        switch (state) {
          case 'working': {
            if (!activeTaskIds[agentName]) {
              const task = core.addTask({
                title: `${label}: ${message?.slice(0, 60) ?? 'Working...'}`,
                description: message ?? '',
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
              core.setTaskOutput(taskId, message ?? 'Done.');
              core.approveTask(taskId);
              delete activeTaskIds[agentName];
            }
            // Flush streamed LLM output as a chat message
            const streamed = useVantageStore.getState().streamingText;
            if (streamed) {
              core.appendAgentHistory(1, 'assistant', [
                `**[${label}]**\n\n${streamed}`,
              ]);
              useVantageStore.getState().clearStreamingText();
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
              core.submitTaskForReview(taskId, message ?? 'Approval required.');
            }
            break;
          }
        }
      }

      // ── HITL pause ───────────────────────────────────────────────────────
      if (type === 'hitl_required' || state === 'waiting_approval') {
        // Flush any partial streamed text before showing modal
        const hitlStream = useVantageStore.getState().streamingText;
        if (hitlStream) {
          const hitlAgent = useVantageStore.getState().streamingAgent;
          core.appendAgentHistory(1, 'assistant', [
            `**[${AGENT_LABEL[hitlAgent] ?? hitlAgent}]**\n\n${hitlStream}`,
          ]);
          useVantageStore.getState().clearStreamingText();
        }
        const hitlType = (packet.hitl_type as string) ?? 'unknown';
        const sessionId = (useUiStore.getState() as any).vantageSessionId;

        if (isAlwaysAllowed(hitlType) && sessionId) {
          // Auto-approve — user previously clicked "Always Allow" for this type
          resolveHITL(sessionId, true).catch(() => {});
          useCoreStore.getState().appendAgentHistory(1, 'assistant', [
            `⚡ Auto-approved \`${hitlType}\` (Always Allow active).`,
          ]);
        } else {
          ui.setVantageHitl({
            type: hitlType,
            description: message ?? 'Agent requires approval.',
          });
        }
      }

      // ── Pipeline complete ────────────────────────────────────────────────
      if (type === 'pipeline_done') {
        // Flush any in-flight streaming text
        const remainingStream = useVantageStore.getState().streamingText;
        if (remainingStream) {
          const streamAgent = useVantageStore.getState().streamingAgent;
          core.appendAgentHistory(1, 'assistant', [
            `**[${AGENT_LABEL[streamAgent] ?? streamAgent}]**\n\n${remainingStream}`,
          ]);
          useVantageStore.getState().clearStreamingText();
        }

        Object.keys(activeTaskIds).forEach((name) => delete activeTaskIds[name]);
        Object.values(AGENT_INDEX).forEach((idx) => ui.setAgentStatus(idx, 'idle'));
        core.setPhase('done');

        const summary = packet.summary as any;
        let text = '✅ **Pipeline complete!**\n\n';
        if (summary?.files_created?.length) {
          text += `📄 **Created:** ${(summary.files_created as string[]).join(', ')}\n`;
        }
        if (summary?.files_modified?.length) {
          text += `✏️ **Modified:** ${(summary.files_modified as string[]).join(', ')}\n`;
        }
        if (summary && !summary.ast_passed) {
          text += `⚠️ AST findings were accepted by user.\n`;
        }
        text += `\n${message ?? ''}`;
        core.appendAgentHistory(1, 'assistant', [text]);
      }

      // ── Pipeline error ───────────────────────────────────────────────────
      if (type === 'pipeline_error') {
        useVantageStore.getState().clearStreamingText();
        Object.values(AGENT_INDEX).forEach((idx) => ui.setAgentStatus(idx, 'idle'));
        core.setPhase('idle');
        core.appendAgentHistory(1, 'assistant', [
          `❌ **Pipeline error:** ${message}`,
        ]);
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

// Vite HMR: close stale socket so reconnect picks up new onmessage handler
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    socket?.close();
    socket = null;
  });
}
