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

// ── Format raw agent output for readable chat display ─────────────────────

function formatAgentOutput(agentName: string, raw: string): string {
  const trimmed = raw.trim();

  // ── CodePlan: JSON with project_name + plan array ──────────────────────
  if (agentName === 'codeplan') {
    try {
      const match = trimmed.match(/\{[\s\S]*\}/);
      if (match) {
        const obj = JSON.parse(match[0]);
        const lines: string[] = [];
        if (obj.project_name) {
          lines.push(`📁 **Project:** \`${obj.project_name}\``);
        }
        if (Array.isArray(obj.plan) && obj.plan.length) {
          lines.push('', '**Execution Plan**');
          obj.plan.forEach((step: string, i: number) => {
            // Strip leading "Step N:" if present
            const clean = step.replace(/^Step\s*\d+:\s*/i, '');
            lines.push(`${i + 1}. ${clean}`);
          });
        }
        if (Array.isArray(obj.risky_overwrites) && obj.risky_overwrites.length) {
          lines.push('', `⚠️ **May overwrite:** ${obj.risky_overwrites.map((f: string) => `\`${f}\``).join(', ')}`);
        }
        if (lines.length) return lines.join('\n');
      }
    } catch { /* not JSON — fall through */ }
  }

  // ── Parsel: JSON array of decomposed tasks ─────────────────────────────
  if (agentName === 'parsel') {
    try {
      // Could be raw array or wrapped in JSON object
      const match = trimmed.match(/\[[\s\S]*\]/);
      if (match) {
        const tasks = JSON.parse(match[0]) as Array<{
          function_name?: string;
          purpose?: string;
          signature?: string;
          base_case?: boolean;
          depends_on?: string[];
        }>;
        if (tasks.length && tasks[0].function_name) {
          const lines = ['**Decomposed Tasks**', ''];
          tasks.forEach((t, i) => {
            const icon = t.base_case ? '🟢' : '🔗';
            lines.push(`${icon} **${i + 1}. \`${t.function_name}\`** — ${t.purpose ?? ''}`);
            if (t.signature) {
              lines.push(`   \`${t.signature}\``);
            }
            if (t.depends_on?.length) {
              lines.push(`   ↳ depends on: ${t.depends_on.map(d => `\`${d}\``).join(', ')}`);
            }
          });
          return lines.join('\n');
        }
      }
    } catch { /* fall through */ }
  }

  // ── AutoCodeRover: JSON with approved, issues, summary, patches ────────
  if (agentName === 'autocoderover') {
    try {
      const match = trimmed.match(/\{[\s\S]*\}/);
      if (match) {
        const obj = JSON.parse(match[0]);
        if ('approved' in obj || 'issues' in obj || 'summary' in obj) {
          const lines: string[] = [];
          const passed = obj.approved !== false && (!obj.issues || obj.issues.length === 0);
          lines.push(passed ? '✅ **Code Review: Passed**' : '⚠️ **Code Review: Issues Found**');
          if (obj.summary) {
            lines.push('', obj.summary);
          }
          if (Array.isArray(obj.issues) && obj.issues.length) {
            lines.push('', '**Issues:**');
            obj.issues.forEach((issue: string) => {
              lines.push(`- ${issue}`);
            });
          }
          if (Array.isArray(obj.patches) && obj.patches.length) {
            lines.push('', `🔧 **Auto-patched ${obj.patches.length} file(s)**`);
            obj.patches.forEach((p: { path?: string }) => {
              if (p.path) lines.push(`  - \`${p.path}\``);
            });
          }
          return lines.join('\n');
        }
      }
    } catch { /* fall through */ }
  }

  // ── SWE-Agent: streamed tool calls + reasoning ─────────────────────────
  if (agentName === 'swe_agent') {
    // Keep tool call lines (backtick format) and meaningful output.
    // Strip verbose self-talk / reasoning filler.
    const lines = trimmed.split('\n');
    const kept: string[] = [];
    for (const line of lines) {
      const t = line.trim();
      // Keep tool call backtick lines
      if (t.startsWith('`') && t.includes('(')) {
        kept.push(t);
        continue;
      }
      // Keep lines with file paths or code-related content
      if (t.match(/^(Created|Modified|Wrote|Read|Edited|Deleted|Running|Error|Warning|✓|✗|→|─)/i)) {
        kept.push(t);
        continue;
      }
      // Keep short meaningful lines (skip long reasoning blocks)
      if (t.length > 0 && t.length < 120 && !t.match(/^(I |Let me |Now I |I'll |I need to |I should |I want to |I will |Okay|Ok,|Alright|Let's|Next,|First,|Then )/i)) {
        kept.push(t);
      }
    }
    if (kept.length) {
      return kept.join('\n');
    }
  }

  // ── Fallback: try generic JSON formatting ──────────────────────────────
  try {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (match) {
      const obj = JSON.parse(match[0]);
      // Format known fields nicely
      const lines: string[] = [];
      for (const [key, val] of Object.entries(obj)) {
        if (Array.isArray(val)) {
          lines.push(`**${key}:**`);
          (val as unknown[]).forEach((item) => {
            lines.push(`- ${typeof item === 'string' ? item : JSON.stringify(item)}`);
          });
        } else if (typeof val === 'string') {
          lines.push(`**${key}:** ${val}`);
        } else if (typeof val === 'boolean') {
          lines.push(`**${key}:** ${val ? '✅' : '❌'}`);
        }
      }
      if (lines.length) return lines.join('\n');
    }
  } catch { /* not JSON */ }

  // Raw text — return as-is
  return trimmed;
}

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

      const type = packet.type as string | undefined;

      // ── Skip logging high-frequency stream packets ────────────────────────
      if (type !== 'agent_token' && type !== 'tool_call') {
        vantage.appendWsLog({ ts: Date.now(), raw, packet });
      }
      const agentName = (packet.agent as string) ?? '';
      // worker_0, worker_1 etc all animate the swe_agent NPC (index 4)
      const agentIdx = agentName.startsWith('worker_') ? 4 : AGENT_INDEX[agentName];
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

      // Tool call event — compact indicator in stream + 3D bubble text
      if (type === 'tool_call') {
        const tool = packet.tool as string;
        const args = packet.args as Record<string, unknown>;
        const firstArg = args ? Object.values(args)[0] : '';
        const preview = typeof firstArg === 'string' ? firstArg.slice(0, 50) : '';
        vantage.appendStreamingChunk(
          agentName || 'swe_agent',
          `\n\`${tool}(${preview ? `"${preview}"` : ''})\``,
        );
        // Update 3D bubble over NPC
        const bubbleLabel = preview ? `${tool} · ${preview.split('/').pop()}` : tool;
        vantage.setAgentBubbleText(agentName || 'swe_agent', bubbleLabel);
        return;
      }

      // File write event: update content cache + live tree + mark as modifying
      if (type === 'file_write') {
        const path = packet.path as string;
        const content = packet.content as string;
        vantage.setFileContent(path, content);
        vantage.upsertFileInTree(path);   // live tree update during pipeline
        vantage.setModifyingFile(path, true);
        setTimeout(() => {
          useVantageStore.getState().setModifyingFile(path, false);
        }, 2000);
      }

      // Plan approval gate — CodePlan broadcast the plan, graph is now paused
      if (type === 'plan_ready') {
        const plan = packet.plan as string[];
        vantage.setExecutionPlan(plan);
        vantage.setPlanApprovalPending(true);
        return;
      }

      // Individual plan step progress (from parallel workers)
      if (type === 'plan_step_update') {
        const idx = packet.step_index as number;
        const status = packet.status as 'pending' | 'working' | 'done' | 'error';
        vantage.setPlanStepStatus(idx, status);
        return;
      }

      // Parallel worker lifecycle
      if (type === 'worker_start') {
        const wid = packet.worker_id as number;
        const workerTask = packet.task as string;
        vantage.setActiveWorkerCount(useVantageStore.getState().activeWorkerCount + 1);
        vantage.setAgentBubbleText('swe_agent',
          `${useVantageStore.getState().activeWorkerCount} worker(s) active`);
        core.appendAgentHistory(1, 'assistant', [
          `**[Worker ${wid}]** Starting: ${workerTask}`,
        ]);
        if (agentIdx !== undefined) ui.setAgentStatus(4, 'working'); // swe_agent NPC
        return;
      }

      if (type === 'worker_complete') {
        const wid = packet.worker_id as number;
        const files = (packet.files as string[]) ?? [];
        const newCount = Math.max(0, useVantageStore.getState().activeWorkerCount - 1);
        vantage.setActiveWorkerCount(newCount);
        if (newCount === 0) vantage.clearAgentBubbleText('swe_agent');
        if (files.length) {
          core.appendAgentHistory(1, 'assistant', [
            `**[Worker ${wid}]** Done — ${files.map(f => `\`${f}\``).join(', ')}`,
          ]);
        }
        return;
      }

      // TRUST PILLAR 3: File diff — show exactly what changed
      if (type === 'file_diff') {
        const path = packet.path as string;
        const diff = packet.diff as string;
        if (diff) {
          const lines = diff.split('\n');
          // Truncate very large diffs to first 60 lines
          const truncated = lines.length > 60
            ? lines.slice(0, 60).join('\n') + `\n… (+${lines.length - 60} more lines)`
            : diff;
          core.appendAgentHistory(1, 'assistant', [
            `**[SWE-Agent]** \`${path}\`\n\`\`\`diff\n${truncated}\n\`\`\``,
          ]);
        }
      }

      // TRUST PILLAR 1: Verification result — pass/fail in chat
      if (type === 'verification_result') {
        const passed = packet.passed as boolean;
        const summary = packet.summary as string;
        const errors = (packet.errors as string[]) ?? [];
        if (passed) {
          core.appendAgentHistory(1, 'assistant', [
            `**[SWE-Agent]** ✅ **Verification passed** — ${summary}`,
          ]);
        } else {
          const errLines = errors.slice(0, 5).map((e) => `- ${e}`).join('\n');
          const more = errors.length > 5 ? `\n- … (+${errors.length - 5} more)` : '';
          core.appendAgentHistory(1, 'assistant', [
            `**[SWE-Agent]** ❌ **Verification failed**\n${summary}\n\n${errLines}${more}`,
          ]);
        }
      }

      // TRUST PILLAR 2: Git commit — compact one-liner in chat
      if (type === 'git_commit') {
        const hash = packet.hash as string;
        const gitMsg = packet.message as string;
        core.appendAgentHistory(1, 'assistant', [
          `**[SWE-Agent]** 🔒 \`${hash}\` — ${gitMsg}`,
        ]);
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

      // Track current pipeline node + 3D bubble text
      if (agentName && state === 'working') {
        vantage.setCurrentNode(agentName);
        vantage.setAgentBubbleText(agentName, message?.slice(0, 35) ?? 'Working…');
      }
      if (agentName && state === 'complete') {
        vantage.clearAgentBubbleText(agentName);
      }
      if (type === 'pipeline_done' || type === 'pipeline_error') {
        vantage.setCurrentNode('');
        // Clear all bubbles
        Object.keys(vantage.agentBubbleText).forEach((k) => vantage.clearAgentBubbleText(k));
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
            // Flush streamed LLM output as a formatted chat message
            const streamed = useVantageStore.getState().streamingText;
            if (streamed) {
              const formatted = formatAgentOutput(agentName, streamed);
              core.appendAgentHistory(1, 'assistant', [
                `**[${label}]**\n\n${formatted}`,
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
          const hitlFormatted = formatAgentOutput(hitlAgent, hitlStream);
          core.appendAgentHistory(1, 'assistant', [
            `**[${AGENT_LABEL[hitlAgent] ?? hitlAgent}]**\n\n${hitlFormatted}`,
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
          const doneFormatted = formatAgentOutput(streamAgent, remainingStream);
          core.appendAgentHistory(1, 'assistant', [
            `**[${AGENT_LABEL[streamAgent] ?? streamAgent}]**\n\n${doneFormatted}`,
          ]);
          useVantageStore.getState().clearStreamingText();
        }

        Object.keys(activeTaskIds).forEach((name) => delete activeTaskIds[name]);
        Object.values(AGENT_INDEX).forEach((idx) => ui.setAgentStatus(idx, 'idle'));
        core.setPhase('done');
        // Mark all plan steps done and clear pending state
        useVantageStore.getState().executionPlan.forEach((_, i) =>
          useVantageStore.getState().setPlanStepStatus(i, 'done')
        );
        useVantageStore.getState().setPlanApprovalPending(false);
        useVantageStore.getState().setActiveWorkerCount(0);

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
        useVantageStore.getState().setPlanApprovalPending(false);
        useVantageStore.getState().setActiveWorkerCount(0);
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
