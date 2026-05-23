import React, { useEffect, useRef, useState, useCallback, KeyboardEvent } from 'react';
import { Bot, Radio, Terminal } from 'lucide-react';
import { useVantageStore } from '../../integration/store/vantageStore';
import { useUiStore } from '../../integration/store/uiStore';

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function packetSummary(raw: string): { label: string; color: string } {
  try {
    const p = JSON.parse(raw);
    const type = p.type ?? p.state ?? 'event';
    const agent = p.agent ? `[${p.agent}] ` : '';
    const msg = p.message ? ` — ${p.message.slice(0, 80)}` : '';
    const colors: Record<string, string> = {
      file_write: '#06b6d4',
      file_tree: '#8b5cf6',
      dependency_map: '#f59e0b',
      terminal_output: '#22c55e',
      hitl_required: '#ef4444',
      pipeline_done: '#10b981',
      pipeline_error: '#ef4444',
      working: '#60a5fa',
      complete: '#34d399',
      error: '#f87171',
    };
    return { label: `${agent}${type}${msg}`, color: colors[type] ?? '#9ca3af' };
  } catch {
    return { label: raw.slice(0, 120), color: '#6b7280' };
  }
}

// ── Agent Terminal (pipeline bash output) ────────────────────────────────
const AgentTerminal: React.FC = () => {
  const terminalLog = useVantageStore((s) => s.terminalLog);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [terminalLog]);

  return (
    <pre className="flex-1 overflow-y-auto [scrollbar-width:thin] [scrollbar-color:#3f3f46_transparent] px-2 py-1 font-mono text-[10px] text-amber-300 bg-zinc-950 whitespace-pre-wrap break-all leading-relaxed">
      {terminalLog.length === 0
        ? <span className="text-zinc-600">Agent bash output appears here during pipeline…</span>
        : terminalLog.map((e, i) => (
            <span key={i}>
              <span className="text-zinc-600">{fmtTime(e.ts)} </span>
              {e.output}
            </span>
          ))
      }
      <div ref={endRef} />
    </pre>
  );
};

// ── User Interactive Terminal ─────────────────────────────────────────────
const UserTerminal: React.FC = () => {
  const [termOutput, setTermOutput] = useState<string>('');
  const [termCwd, setTermCwd] = useState<string>('');
  const [termInput, setTermInput] = useState<string>('');
  const [termBusy, setTermBusy] = useState<boolean>(false);
  const [termConnected, setTermConnected] = useState<boolean>(false);
  const [cmdHistory, setCmdHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState<number>(-1);
  const wsRef = useRef<WebSocket | null>(null);
  const outputRef = useRef<HTMLPreElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Connect on mount, cwd = saved workspace path
  useEffect(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      inputRef.current?.focus();
      return;
    }

    const ws = new WebSocket('ws://localhost:8000/ws/terminal');
    wsRef.current = ws;

    ws.onopen = () => {
      setTermConnected(true);
      const workspacePath = (useUiStore.getState().llmConfig as any).workspacePath || '';
      ws.send(JSON.stringify({ type: 'init', cwd: workspacePath }));
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string);
        if (data.type === 'output') {
          setTermOutput((prev) => prev + (data.text as string));
        } else if (data.type === 'cwd') {
          setTermCwd(data.path as string);
        } else if (data.type === 'done') {
          setTermBusy(false);
          setTimeout(() => inputRef.current?.focus(), 50);
        }
      } catch { /* ignore */ }
    };

    ws.onclose = () => {
      setTermConnected(false);
      setTermBusy(false);
      wsRef.current = null;
    };

    ws.onerror = () => ws.close();

    return () => { ws.close(); };
  }, []);

  // Auto-scroll
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [termOutput]);

  const sendCommand = useCallback(() => {
    const cmd = termInput.trim();
    if (!cmd || termBusy || wsRef.current?.readyState !== WebSocket.OPEN) return;
    setCmdHistory((prev) => [cmd, ...prev].slice(0, 100));
    setHistoryIdx(-1);
    const prompt = termCwd ? `${termCwd.replace(/\\/g, '/').split('/').slice(-2).join('/')}$ ` : '$ ';
    setTermOutput((prev) => prev + `\n${prompt}${cmd}\n`);
    setTermInput('');
    setTermBusy(true);
    wsRef.current.send(JSON.stringify({ type: 'command', command: cmd }));
  }, [termInput, termBusy, termCwd]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        sendCommand();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const next = Math.min(historyIdx + 1, cmdHistory.length - 1);
        setHistoryIdx(next);
        if (cmdHistory[next] !== undefined) setTermInput(cmdHistory[next]);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        const next = Math.max(historyIdx - 1, -1);
        setHistoryIdx(next);
        setTermInput(next === -1 ? '' : cmdHistory[next] ?? '');
      } else if (e.key === 'c' && e.ctrlKey) {
        setTermOutput((prev) => prev + '^C\n');
        setTermBusy(false);
      }
    },
    [sendCommand, historyIdx, cmdHistory],
  );

  const shortCwd = termCwd
    ? termCwd.replace(/\\/g, '/').split('/').slice(-2).join('/')
    : '';

  return (
    <div
      className="flex-1 flex flex-col bg-zinc-950 overflow-hidden"
      onClick={() => inputRef.current?.focus()}
    >
      <pre
        ref={outputRef}
        className="flex-1 overflow-y-auto [scrollbar-width:thin] [scrollbar-color:#3f3f46_transparent] px-2 py-1 font-mono text-[10px] text-green-400 whitespace-pre-wrap break-all leading-relaxed"
      >
        {termOutput || (
          <span className="text-zinc-600">
            {termConnected ? 'Terminal ready. Type a command below.' : 'Connecting…'}
          </span>
        )}
      </pre>
      <div className="shrink-0 flex items-center gap-1 px-2 py-1 border-t border-zinc-800 bg-zinc-900">
        <span className="text-green-500 font-mono text-[10px] shrink-0 select-none">
          {shortCwd ? `${shortCwd}$` : '$'}
        </span>
        <input
          ref={inputRef}
          value={termInput}
          onChange={(e) => setTermInput(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={!termConnected}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          className="flex-1 bg-transparent outline-none font-mono text-[10px] text-green-300 placeholder-zinc-600 disabled:opacity-40 caret-green-400"
          placeholder={termConnected ? (termBusy ? 'running…' : 'enter command') : 'not connected'}
        />
        {termBusy && (
          <span className="text-zinc-500 font-mono text-[9px] shrink-0 animate-pulse">▋</span>
        )}
      </div>
    </div>
  );
};

// ── Main Console ──────────────────────────────────────────────────────────
export const VantageConsole: React.FC = () => {
  const { wsLog, consoleTab, setConsoleTab } = useVantageStore();
  const eventsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    eventsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [wsLog]);

  return (
    <div className="h-full flex flex-col border-t border-zinc-200 bg-white">
      {/* Tabs */}
      <div className="h-8 flex items-center border-b border-zinc-200 shrink-0 px-1 gap-0.5">
        <button
          onClick={() => setConsoleTab('events')}
          className={`flex items-center gap-1.5 px-3 h-full text-[10px] font-black uppercase tracking-widest transition-colors ${
            consoleTab === 'events'
              ? 'text-cyan-400 border-b-2 border-cyan-500'
              : 'text-zinc-400 hover:text-zinc-600'
          }`}
        >
          <Radio size={10} />
          Events
          {wsLog.length > 0 && (
            <span className="bg-zinc-100 text-zinc-500 px-1 rounded text-[9px]">{wsLog.length}</span>
          )}
        </button>

        <button
          onClick={() => setConsoleTab('agent-terminal')}
          className={`flex items-center gap-1.5 px-3 h-full text-[10px] font-black uppercase tracking-widest transition-colors ${
            consoleTab === 'agent-terminal'
              ? 'text-amber-400 border-b-2 border-amber-500'
              : 'text-zinc-400 hover:text-zinc-600'
          }`}
        >
          <Bot size={10} />
          Agent
        </button>

        <button
          onClick={() => setConsoleTab('terminal')}
          className={`flex items-center gap-1.5 px-3 h-full text-[10px] font-black uppercase tracking-widest transition-colors ${
            consoleTab === 'terminal'
              ? 'text-green-400 border-b-2 border-green-500'
              : 'text-zinc-400 hover:text-zinc-600'
          }`}
        >
          <Terminal size={10} />
          Terminal
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {consoleTab === 'events' && (
          <div className="flex-1 overflow-y-auto [scrollbar-width:thin] [scrollbar-color:theme(colors.zinc.300)_transparent] py-1 font-mono">
            {wsLog.length === 0 ? (
              <p className="text-[10px] text-zinc-400 px-3 py-2">No events yet.</p>
            ) : (
              wsLog.map((entry, i) => {
                const { label, color } = packetSummary(entry.raw);
                return (
                  <div key={i} className="flex items-start gap-2 px-3 py-0.5 hover:bg-zinc-50 text-[10px]">
                    <span className="text-zinc-400 shrink-0 tabular-nums">{fmtTime(entry.ts)}</span>
                    <span style={{ color }} className="truncate">{label}</span>
                  </div>
                );
              })
            )}
            <div ref={eventsEndRef} />
          </div>
        )}

        {consoleTab === 'agent-terminal' && <AgentTerminal />}
        {consoleTab === 'terminal' && <UserTerminal />}
      </div>
    </div>
  );
};
