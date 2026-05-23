import React, { useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  Loader2,
  AlertTriangle,
  Send,
  Square,
  XCircle,
  Terminal,
  ToggleLeft,
  ToggleRight,
} from 'lucide-react';
import { useVantageStore } from '../../integration/store/vantageStore';
import { useUiStore } from '../../integration/store/uiStore';
import { useCoreStore } from '../../integration/store/coreStore';
import { startVantagePipeline, stopVantagePipeline } from '../../integration/vantageApi';
import { connectVantageWs } from '../../integration/vantageWs';
import { resolveHITL } from '../../integration/vantageApi';
import { addAlwaysAllowed, isAlwaysAllowed } from '../../integration/vantageAlwaysAllow';
import { VantagePlanView } from './VantagePlanView';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const AGENT_COLORS: Record<string, string> = {
  codeplan:      'bg-cyan-500',
  parsel:        'bg-violet-500',
  swe_agent:     'bg-orange-500',
  autocoderover: 'bg-pink-500',
  orchestrator:  'bg-yellow-500',
};

// ── Message renderer ──────────────────────────────────────────────────────

function ChatMessage({ msg }: { msg: any }) {
  const isUser = msg.role === 'user';

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] bg-zinc-900 text-white rounded-2xl rounded-br-sm px-3 py-2 text-[11px] leading-relaxed">
          <span className="whitespace-pre-wrap break-words">{msg.content}</span>
        </div>
      </div>
    );
  }

  // Detect agent label from content like **[CodePlan]**
  const agentMatch = msg.content?.match(/^\*\*\[([^\]]+)\]\*\*/);
  const agentLabel = agentMatch?.[1] ?? null;
  const agentKey = agentLabel?.toLowerCase().replace(/-/g, '_').replace(' ', '_') ?? '';
  const dotColor = AGENT_COLORS[agentKey] ?? 'bg-zinc-400';

  return (
    <div className="flex flex-col gap-1">
      {agentLabel && (
        <div className="flex items-center gap-1.5 px-1">
          <span className={`w-1.5 h-1.5 rounded-full ${dotColor} shrink-0`} />
          <span className="text-[9px] font-black uppercase tracking-widest text-zinc-400">
            {agentLabel}
          </span>
        </div>
      )}
      <div className="max-w-[95%] bg-zinc-50 border border-zinc-200 rounded-2xl rounded-tl-sm px-3 py-2 text-[11px] leading-relaxed text-zinc-700">
        <div className="prose prose-zinc prose-xs max-w-none overflow-hidden
          [&_pre]:overflow-x-auto [&_pre]:text-[9px] [&_pre]:bg-zinc-900
          [&_pre]:text-zinc-100 [&_pre]:rounded-lg [&_pre]:p-2 [&_pre]:my-1.5
          [&_pre]:whitespace-pre-wrap [&_code]:break-words
          [&_code:not(pre_code)]:bg-zinc-200 [&_code:not(pre_code)]:px-1 [&_code:not(pre_code)]:rounded
          [&_code:not(pre_code)]:text-[10px] [&_code:not(pre_code)]:text-zinc-700
          [&_p]:break-words [&_p]:my-1 [&_li]:break-words [&_li]:my-0.5
          [&_ol]:my-1 [&_ol]:pl-4 [&_ol]:list-decimal
          [&_ul]:my-1 [&_ul]:pl-4 [&_ul]:list-disc
          [&_h1]:text-[12px] [&_h1]:font-black [&_h1]:text-zinc-800
          [&_h2]:text-[11px] [&_h2]:font-bold [&_h2]:text-zinc-700
          [&_h3]:text-[11px] [&_h3]:font-semibold [&_h3]:text-zinc-600
          [&_strong]:text-zinc-800 [&_hr]:my-2 [&_hr]:border-zinc-200">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {agentLabel
              ? msg.content.replace(/^\*\*\[[^\]]+\]\*\*\n\n?/, '')
              : msg.content}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  );
}

// ── Streaming bubble ──────────────────────────────────────────────────────

function StreamingBubble({
  text,
  agent,
}: {
  text: string;
  agent: string;
}) {
  const dotColor = AGENT_COLORS[agent] ?? 'bg-zinc-400';
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5 px-1">
        <span className={`w-1.5 h-1.5 rounded-full ${dotColor} animate-pulse shrink-0`} />
        <span className="text-[9px] font-black uppercase tracking-widest text-zinc-400">
          {agent.replace('_', '-')} · live
        </span>
        <Loader2 size={8} className="animate-spin text-zinc-400" />
      </div>
      <div className="max-w-[95%] bg-zinc-50 border border-zinc-200 rounded-2xl rounded-tl-sm px-3 py-2 text-[10px] leading-relaxed text-zinc-700 font-mono">
        <span className="whitespace-pre-wrap break-all">{text}</span>
        <span className="inline-block w-1.5 h-3.5 bg-zinc-400 animate-pulse ml-0.5 align-middle rounded-sm" />
      </div>
    </div>
  );
}

// ── HITL inline card ──────────────────────────────────────────────────────

function HitlCard({
  hitl,
  onApprove,
  onReject,
  onAlwaysAllow,
}: {
  hitl: { type: string; description: string };
  onApprove: () => void;
  onReject: () => void;
  onAlwaysAllow: () => void;
}) {
  const [alwaysOn, setAlwaysOn] = useState(isAlwaysAllowed(hitl.type));

  const handleApprove = () => {
    if (alwaysOn) onAlwaysAllow();
    else onApprove();
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5 px-1">
        <AlertTriangle size={10} className="text-amber-500 shrink-0" />
        <span className="text-[9px] font-black uppercase tracking-widest text-amber-500">
          approval required
        </span>
      </div>
      <div className="border border-amber-200 bg-amber-50 rounded-2xl rounded-tl-sm p-3 flex flex-col gap-3">
        <p className="text-[11px] text-zinc-700 leading-relaxed">{hitl.description}</p>

        {/* Always-allow toggle */}
        <button
          onClick={() => setAlwaysOn((v) => !v)}
          className="flex items-center gap-2 group w-fit"
        >
          {alwaysOn ? (
            <ToggleRight size={16} className="text-cyan-500 shrink-0" />
          ) : (
            <ToggleLeft size={16} className="text-zinc-400 shrink-0" />
          )}
          <span
            className={`text-[10px] font-bold transition-colors ${
              alwaysOn ? 'text-cyan-600' : 'text-zinc-400'
            }`}
          >
            Always allow <span className="font-mono">"{hitl.type}"</span>
          </span>
        </button>

        {/* Action buttons */}
        <div className="flex gap-2">
          <button
            onClick={handleApprove}
            className="flex-1 flex items-center justify-center gap-1.5 py-2 bg-zinc-900 hover:bg-zinc-700 text-white rounded-xl text-[10px] font-black uppercase tracking-widest transition-all active:scale-95"
          >
            <CheckCircle2 size={11} />
            {alwaysOn ? 'Allow Always' : 'Approve'}
          </button>
          <button
            onClick={onReject}
            className="flex items-center justify-center gap-1.5 px-3 py-2 bg-red-50 hover:bg-red-100 border border-red-200 text-red-600 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all active:scale-95"
          >
            <XCircle size={11} />
            Reject
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────

export const VantageTelemetryPanel: React.FC = () => {
  const { currentNode, streamingText, streamingAgent } = useVantageStore();
  const {
    vantageHitl,
    setVantageHitl,
    vantageSessionId,
    llmConfig,
    setVantageSessionId,
    setIsTyping,
    setChatting,
    setSelectedNpc,
  } = useUiStore() as any;
  const core = useCoreStore();

  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messages = core.agentHistories[1] ?? [];

  // Auto-expand textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
    }
  }, [input]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingText, vantageHitl]);

  const handleSend = async () => {
    if (!input.trim() || sending) return;
    const text = input.trim();
    setInput('');
    setSending(true);
    setChatting(false);
    setIsTyping(false);

    core.appendAgentHistory(1, 'user', [text]);
    core.startProject(text);

    if (!llmConfig?.apiKey) {
      core.appendAgentHistory(1, 'assistant', ['⚠️ No API key — click the key icon to configure.']);
      setSending(false);
      return;
    }
    if (!llmConfig?.workspacePath) {
      core.appendAgentHistory(1, 'assistant', ['⚠️ No workspace path — click the key icon to configure.']);
      setSending(false);
      return;
    }

    core.appendAgentHistory(1, 'assistant', ['Initializing VANTAGE pipeline…']);
    connectVantageWs();

    const result = await startVantagePipeline(text, llmConfig.workspacePath, llmConfig.apiKey);
    if ('session_id' in result) {
      setVantageSessionId(result.session_id);
      core.appendAgentHistory(1, 'assistant', [
        `Pipeline started\n\n\`${result.session_id.slice(0, 8)}…\`\n\n**CodePlan → Parsel → SWE-Agent → AutoCodeRover**`,
      ]);
    } else {
      core.appendAgentHistory(1, 'assistant', [`❌ Backend error: ${(result as any).error}`]);
      core.setPhase('idle');
    }
    setSending(false);
  };

  const pipelineRunning = !!currentNode || sending;

  const handleStop = async () => {
    if (vantageSessionId) await stopVantagePipeline(vantageSessionId);
    setSending(false);
    setChatting(false);
    setIsTyping(false);
    core.setPhase('idle');
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

  const visibleMessages = messages.filter((m: any) => !m.metadata?.internal);

  return (
    <div className="w-full h-full bg-white border-l border-zinc-100 flex flex-col overflow-hidden">

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="h-9 flex items-center justify-between px-3 border-b border-zinc-100 shrink-0">
        <div className="flex items-center gap-1.5">
          <Terminal size={11} className="text-zinc-400" />
          <span className="text-[9px] font-black uppercase tracking-[0.2em] text-zinc-400">
            FORGE
          </span>
        </div>
        {currentNode && (
          <span className="text-[9px] text-cyan-500 font-black uppercase tracking-widest flex items-center gap-1">
            <span className="w-1 h-1 rounded-full bg-cyan-400 animate-pulse inline-block" />
            {currentNode.replace('_', '-')}
          </span>
        )}
      </div>

      {/* ── Notion-style plan view ──────────────────────────────────────── */}
      <VantagePlanView />

      {/* ── Chat ─────────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-3 min-h-0 [scrollbar-width:thin] [scrollbar-color:theme(colors.zinc.200)_transparent]">
        {visibleMessages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-center pb-4">
            <div className="w-8 h-8 rounded-full bg-zinc-100 flex items-center justify-center">
              <Terminal size={14} className="text-zinc-400" />
            </div>
            <p className="text-[10px] text-zinc-400 leading-relaxed">
              Describe what to build.<br />VANTAGE will plan and execute it.
            </p>
          </div>
        ) : (
          <>
            {visibleMessages.map((msg: any, i: number) => (
              <ChatMessage key={i} msg={msg} />
            ))}
          </>
        )}

        {/* Live streaming bubble */}
        {streamingText && (
          <StreamingBubble text={streamingText} agent={streamingAgent || 'agent'} />
        )}

        {/* HITL inline card — appears at bottom of chat flow */}
        {vantageHitl && (
          <HitlCard
            hitl={vantageHitl}
            onApprove={handleApprove}
            onReject={handleReject}
            onAlwaysAllow={handleAlwaysAllow}
          />
        )}

        <div ref={chatEndRef} />
      </div>

      {/* ── Input ────────────────────────────────────────────────────────── */}
      <div className="p-2 border-t border-zinc-100 shrink-0">
        <div className="flex items-end gap-1.5 bg-zinc-50 border border-zinc-200 rounded-2xl px-3 py-2 focus-within:border-zinc-400 transition-colors">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              if (e.target.value.trim()) {
                setSelectedNpc(1);
                setChatting(true);
                setIsTyping(true);
              } else {
                setChatting(false);
                setIsTyping(false);
              }
            }}
            onBlur={() => { setChatting(false); setIsTyping(false); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder="Describe what to build…"
            rows={1}
            style={{ minHeight: '36px' }}
            className="flex-1 bg-transparent text-[12px] leading-relaxed text-zinc-800 placeholder-zinc-400 resize-none focus:outline-none [scrollbar-width:none]"
          />
          {pipelineRunning ? (
            <button
              onClick={handleStop}
              className="w-7 h-7 rounded-xl flex items-center justify-center transition-all active:scale-95 shrink-0 mb-0.5 bg-red-500 hover:bg-red-400 text-white"
              title="Stop pipeline"
            >
              <Square size={11} fill="currentColor" />
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!input.trim()}
              className={`w-7 h-7 rounded-xl flex items-center justify-center transition-all active:scale-95 shrink-0 mb-0.5 ${
                input.trim()
                  ? 'bg-zinc-900 hover:bg-zinc-700 text-white'
                  : 'bg-zinc-200 text-zinc-400 cursor-not-allowed'
              }`}
            >
              <Send size={12} />
            </button>
          )}
        </div>
        <p className="text-[8px] text-zinc-300 mt-1 text-center tracking-widest uppercase">
          ↵ send · shift+↵ newline
        </p>
      </div>
    </div>
  );
};
