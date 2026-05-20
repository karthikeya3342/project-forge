import React, { useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  Circle,
  Loader2,
  AlertTriangle,
  ChevronRight,
  Send,
  AlertCircle,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { useVantageStore } from '../../integration/store/vantageStore';
import { useUiStore } from '../../integration/store/uiStore';
import { useCoreStore } from '../../integration/store/coreStore';
import { startVantagePipeline } from '../../integration/vantageApi';
import { connectVantageWs } from '../../integration/vantageWs';
import { resolveHITL } from '../../integration/vantageApi';
import { addAlwaysAllowed } from '../../integration/vantageAlwaysAllow';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const PIPELINE_NODES = [
  { id: 'codeplan', label: 'CodePlan', desc: 'Repository scan' },
  { id: 'parsel', label: 'Parsel', desc: 'Task decomposer' },
  { id: 'swe_agent', label: 'SWE-Agent', desc: 'Code writer' },
  { id: 'autocoderover', label: 'AutoCodeRover', desc: 'AST auditor' },
];

type NodeStatus = 'idle' | 'working' | 'complete' | 'error' | 'waiting';

function NodeIcon({ status }: { status: NodeStatus }) {
  switch (status) {
    case 'working':
      return <Loader2 size={13} className="text-cyan-400 animate-spin" />;
    case 'complete':
      return <CheckCircle2 size={13} className="text-emerald-400" />;
    case 'error':
      return <AlertCircle size={13} className="text-red-400" />;
    case 'waiting':
      return <AlertTriangle size={13} className="text-amber-400" />;
    default:
      return <Circle size={13} className="text-zinc-400" />;
  }
}

export const VantageTelemetryPanel: React.FC = () => {
  const { currentNode, dependencyMap, wsLog, streamingText, streamingAgent } = useVantageStore();
  const { vantageHitl, setVantageHitl, vantageSessionId, llmConfig, setVantageSessionId } =
    useUiStore() as any;
  const core = useCoreStore();

  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const messages = core.agentHistories[1] ?? [];

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingText]);

  // Derive node statuses from pipeline state
  function nodeStatus(id: string): NodeStatus {
    if (currentNode === id) return 'working';
    // Check recent ws log for agent state
    for (let i = wsLog.length - 1; i >= 0; i--) {
      const p = wsLog[i].packet;
      if (p.agent === id) {
        if (p.state === 'complete') return 'complete';
        if (p.state === 'error') return 'error';
        if (p.state === 'waiting_approval') return 'waiting';
        if (p.state === 'working') {
          // If this node isn't current anymore, it's done
          return currentNode !== id ? 'complete' : 'working';
        }
      }
    }
    return 'idle';
  }

  const handleSend = async () => {
    if (!input.trim() || sending) return;
    const text = input.trim();
    setInput('');
    setSending(true);

    core.appendAgentHistory(1, 'user', [text]);
    core.startProject(text);

    if (!llmConfig?.apiKey) {
      core.appendAgentHistory(1, 'assistant', [
        '⚠️ No API key. Click the key icon in the header to configure.',
      ]);
      setSending(false);
      return;
    }
    if (!llmConfig?.workspacePath) {
      core.appendAgentHistory(1, 'assistant', [
        '⚠️ No workspace path. Click the key icon in the header.',
      ]);
      setSending(false);
      return;
    }

    core.appendAgentHistory(1, 'assistant', ['Initializing VANTAGE pipeline...']);
    connectVantageWs();

    const result = await startVantagePipeline(text, llmConfig.workspacePath, llmConfig.apiKey);
    if ('session_id' in result) {
      setVantageSessionId(result.session_id);
      core.appendAgentHistory(1, 'assistant', [
        `Pipeline started (\`${result.session_id.slice(0, 8)}...\`)\n\n**CodePlan → Parsel → SWE-Agent → AutoCodeRover**`,
      ]);
    } else {
      core.appendAgentHistory(1, 'assistant', [
        `❌ Backend error: ${(result as any).error}`,
      ]);
      core.setPhase('idle');
    }
    setSending(false);
  };

  const handleApprove = async () => {
    if (vantageSessionId) await resolveHITL(vantageSessionId, true);
    setVantageHitl(null);
  };

  const handleReject = async () => {
    if (vantageSessionId) await resolveHITL(vantageSessionId, false);
    setVantageHitl(null);
  };

  const handleAlwaysAllow = async () => {
    if (vantageHitl) addAlwaysAllowed(vantageHitl.type);
    if (vantageSessionId) await resolveHITL(vantageSessionId, true);
    setVantageHitl(null);
  };

  const depEntries = Object.entries(dependencyMap).slice(0, 8);

  return (
    <div className="w-72 h-full bg-white border-l border-zinc-200 flex flex-col overflow-hidden shrink-0">
      {/* Header */}
      <div className="h-9 flex items-center justify-between px-3 border-b border-zinc-200 shrink-0">
        <span className="text-[9px] font-black uppercase tracking-[0.2em] text-zinc-400">
          Telemetry
        </span>
        {currentNode && (
          <span className="text-[9px] text-cyan-400 font-black uppercase tracking-widest">
            ● {currentNode}
          </span>
        )}
      </div>

      <div className="flex-1 flex flex-col min-h-0 overflow-y-auto [scrollbar-width:thin] [scrollbar-color:theme(colors.zinc.300)_transparent]">
        {/* Pipeline */}
        <div className="px-3 py-2 border-b border-zinc-200">
          <p className="text-[9px] font-black uppercase tracking-[0.15em] text-zinc-400 mb-2">
            Pipeline
          </p>
          <div className="flex flex-col gap-1">
            {PIPELINE_NODES.map((node, i) => {
              const status = nodeStatus(node.id);
              return (
                <div key={node.id} className="flex items-center gap-2">
                  <NodeIcon status={status} />
                  <div className="flex-1 min-w-0">
                    <span
                      className={`text-[11px] font-bold ${
                        status === 'working'
                          ? 'text-cyan-600'
                          : status === 'complete'
                          ? 'text-emerald-600'
                          : status === 'error'
                          ? 'text-red-500'
                          : status === 'waiting'
                          ? 'text-amber-600'
                          : 'text-zinc-400'
                      }`}
                    >
                      {node.label}
                    </span>
                    <span className="text-zinc-400 text-[9px] ml-1.5">{node.desc}</span>
                  </div>
                  {i < PIPELINE_NODES.length - 1 && (
                    <ChevronRight size={10} className="text-zinc-300 shrink-0" />
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* HITL */}
        {vantageHitl && (
          <div className="mx-3 my-2 bg-red-50 border border-red-200 rounded-xl p-3 shrink-0">
            <div className="flex items-center gap-2 mb-2">
              <AlertTriangle size={12} className="text-red-500 shrink-0" />
              <span className="text-[9px] font-black uppercase tracking-widest text-red-500">
                HITL Checkpoint
              </span>
            </div>
            <p className="text-[10px] text-zinc-600 leading-relaxed mb-3">
              {vantageHitl.description}
            </p>
            <div className="flex gap-1.5">
              <button
                onClick={handleApprove}
                className="flex-1 flex items-center justify-center gap-1 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-[9px] font-black uppercase tracking-widest transition-all active:scale-95"
              >
                <CheckCircle2 size={11} />
                Approve
              </button>
              <button
                onClick={handleAlwaysAllow}
                className="flex-1 flex items-center justify-center gap-1 py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg text-[9px] font-black uppercase tracking-widest transition-all active:scale-95"
                title="Approve and never ask again for this type"
              >
                <ShieldCheck size={11} />
                Always
              </button>
              <button
                onClick={handleReject}
                className="flex-1 flex items-center justify-center gap-1 py-2 bg-red-600 hover:bg-red-500 text-white rounded-lg text-[9px] font-black uppercase tracking-widest transition-all active:scale-95"
              >
                <XCircle size={11} />
                Reject
              </button>
            </div>
          </div>
        )}

        {/* Dependency map */}
        {depEntries.length > 0 && (
          <div className="px-3 py-2 border-b border-zinc-200">
            <p className="text-[9px] font-black uppercase tracking-[0.15em] text-zinc-400 mb-1.5">
              Dep Map
            </p>
            <div className="flex flex-col gap-0.5">
              {depEntries.map(([file, deps]) => (
                <div key={file} className="text-[9px] font-mono">
                  <span className="text-zinc-400 truncate block">
                    {file.split('/').pop()}
                  </span>
                  {deps.length > 0 && (
                    <span className="text-zinc-400 ml-2">
                      ↳ {deps.map((d) => d.split('/').pop()).join(', ')}
                    </span>
                  )}
                </div>
              ))}
              {Object.keys(dependencyMap).length > 8 && (
                <span className="text-[9px] text-zinc-400">
                  +{Object.keys(dependencyMap).length - 8} more
                </span>
              )}
            </div>
          </div>
        )}

        {/* Chat history */}
        <div className="flex-1 px-3 py-2 min-h-0 overflow-y-auto [scrollbar-width:none]">
          <p className="text-[9px] font-black uppercase tracking-[0.15em] text-zinc-400 mb-2">
            Chat
          </p>
          {messages.length === 0 ? (
            <p className="text-[10px] text-zinc-400">
              Send a message to start the pipeline.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {messages
                .filter((m: any) => !m.metadata?.internal)
                .map((msg: any, i: number) => (
                  <div
                    key={i}
                    className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-[90%] rounded-xl px-2.5 py-1.5 text-[10px] leading-relaxed ${
                        msg.role === 'user'
                          ? 'bg-cyan-50 text-cyan-800 rounded-tr-none'
                          : 'bg-zinc-100 text-zinc-700 rounded-tl-none'
                      }`}
                    >
                      {msg.role === 'assistant' ? (
                        <div className="markdown-vantage prose prose-zinc prose-xs max-w-none">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {msg.content}
                          </ReactMarkdown>
                        </div>
                      ) : (
                        <span className="whitespace-pre-wrap">{msg.content}</span>
                      )}
                    </div>
                  </div>
                ))}
              {/* Live streaming bubble */}
              {streamingText && (
                <div className="flex justify-start">
                  <div className="max-w-[95%] rounded-xl px-2.5 py-1.5 text-[10px] leading-relaxed bg-zinc-50 text-zinc-700 rounded-tl-none border border-zinc-200">
                    <div className="flex items-center gap-1 mb-1 pb-1 border-b border-zinc-100">
                      <Loader2 size={9} className="animate-spin text-cyan-500 shrink-0" />
                      <span className="text-[9px] text-cyan-500 font-black uppercase tracking-widest">
                        {streamingAgent || 'agent'} · streaming
                      </span>
                    </div>
                    <span className="whitespace-pre-wrap font-mono text-[9px] break-all">
                      {streamingText}
                    </span>
                    <span className="inline-block w-1 h-3 bg-cyan-400 animate-pulse ml-0.5 align-middle rounded-sm" />
                  </div>
                </div>
              )}

              <div ref={chatEndRef} />
            </div>
          )}
        </div>
      </div>

      {/* Input */}
      <div className="p-2 border-t border-zinc-200 shrink-0">
        <div className="flex items-end gap-1.5">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder="Describe what to build…"
            rows={2}
            className="flex-1 bg-zinc-50 border border-zinc-300 rounded-xl px-3 py-2 text-[11px] text-zinc-800 placeholder-zinc-400 resize-none focus:outline-none focus:border-cyan-500 transition-colors [scrollbar-width:none]"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || sending}
            className={`w-8 h-8 rounded-xl flex items-center justify-center transition-all active:scale-95 shrink-0 ${
              input.trim() && !sending
                ? 'bg-cyan-600 hover:bg-cyan-500 text-white shadow-lg shadow-cyan-900/50'
                : 'bg-zinc-100 text-zinc-400 cursor-not-allowed'
            }`}
          >
            {sending ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Send size={13} />
            )}
          </button>
        </div>
        <p className="text-[8px] text-zinc-400 mt-1 text-center uppercase tracking-widest">
          ↵ send · shift+↵ newline
        </p>
      </div>
    </div>
  );
};
