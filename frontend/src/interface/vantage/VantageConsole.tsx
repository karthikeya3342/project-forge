import React, { useEffect, useRef, useState, useCallback, KeyboardEvent } from 'react';
import { Terminal, Radio } from 'lucide-react';
import { useVantageStore } from '../../integration/store/vantageStore';

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
    return {
      label: `${agent}${type}${msg}`,
      color: colors[type] ?? '#9ca3af',
    };
  } catch {
    return { label: raw.slice(0, 120), color: '#6b7280' };
  }
}

export const VantageConsole: React.FC = () => {
  const { wsLog, consoleTab, setConsoleTab } = useVantageStore();
  const eventsEndRef = useRef<HTMLDivElement>(null);
  const termOutputRef = useRef<HTMLPreElement>(null);

  // ── Terminal local state ────────────────────────────────────────────────
  const [termOutput, setTermOutput] = useState<string>('');
  const [termCwd, setTermCwd] = useState<string>('');
  const [termInput, setTermInput] = useState<string>('');
  const [termBusy, setTermBusy] = useState<boolean>(false);
  const [termConnected, setTermConnected] = useState<boolean>(false);
  const [cmdHistory, setCmdHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState<number>(-1);
  const wsRef = useRef<WebSocket | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // ── Connect terminal WS when tab first shown ────────────────────────────
  useEffect(() => {
    if (consoleTab !== 'terminal') return;
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      inputRef.current?.focus();
      return;
    }

    const ws = new WebSocket('ws://localhost:8000/ws/terminal');
    wsRef.current = ws;

    ws.onopen = () => {
      setTermConnected(true);
      ws.send(JSON.stringify({ type: 'init', cwd: '' }));
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
          // Focus input after command finishes
          setTimeout(() => inputRef.current?.focus(), 50);
        }
      } catch { /* ignore */ }
    };

    ws.onclose = () => {
      setTermConnected(false);
      setTermBusy(false);
      wsRef.current = null;
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [consoleTab]);

  // ── Cleanup on unmount ─────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      wsRef.current?.close();
    };
  }, []);

  // ── Auto-scroll terminal output ────────────────────────────────────────
  useEffect(() => {
    if (termOutputRef.current) {
      termOutputRef.current.scrollTop = termOutputRef.current.scrollHeight;
    }
  }, [termOutput]);

  // ── Auto-scroll events ─────────────────────────────────────────────────
  useEffect(() => {
    eventsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [wsLog]);

  // ── Send command ───────────────────────────────────────────────────────
  const sendCommand = useCallback(() => {
    const cmd = termInput.trim();
    if (!cmd) return;
    if (termBusy || wsRef.current?.readyState !== WebSocket.OPEN) return;

    // Add to history
    setCmdHistory((prev) => [cmd, ...prev].slice(0, 100));
    setHistoryIdx(-1);

    // Echo command in output
    const prompt = termCwd ? `${termCwd}$ ` : '$ ';
    setTermOutput((prev) => prev + `\n${prompt}${cmd}\n`);
    setTermInput('');
    setTermBusy(true);
    wsRef.current.send(JSON.stringify({ type: 'command', command: cmd }));
  }, [termInput, termBusy, termCwd]);

  // ── Keyboard handler ───────────────────────────────────────────────────
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
        // Ctrl+C: cancel current command display
        setTermOutput((prev) => prev + '^C\n');
        setTermBusy(false);
      }
    },
    [sendCommand, historyIdx, cmdHistory],
  );

  // Shorten cwd for display
  const shortCwd = termCwd
    ? termCwd.replace(/\\/g, '/').split('/').slice(-2).join('/')
    : '';

  return (
    <div className="h-44 flex flex-col border-t border-zinc-200 bg-white shrink-0">
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
          WS Events
          {wsLog.length > 0 && (
            <span className="bg-zinc-100 text-zinc-500 px-1 rounded text-[9px]">
              {wsLog.length}
            </span>
          )}
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
          {termConnected && (
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 ml-0.5" />
          )}
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {consoleTab === 'events' ? (
          <div className="flex-1 overflow-y-auto [scrollbar-width:thin] [scrollbar-color:theme(colors.zinc.300)_transparent] py-1 font-mono">
            {wsLog.length === 0 ? (
              <p className="text-[10px] text-zinc-400 px-3 py-2">No events yet.</p>
            ) : (
              wsLog.map((entry, i) => {
                const { label, color } = packetSummary(entry.raw);
                return (
                  <div
                    key={i}
                    className="flex items-start gap-2 px-3 py-0.5 hover:bg-zinc-50 text-[10px]"
                  >
                    <span className="text-zinc-400 shrink-0 tabular-nums">
                      {fmtTime(entry.ts)}
                    </span>
                    <span style={{ color }} className="truncate">
                      {label}
                    </span>
                  </div>
                );
              })
            )}
            <div ref={eventsEndRef} />
          </div>
        ) : (
          /* ── Interactive Terminal ─────────────────────────────────────── */
          <div
            className="flex-1 flex flex-col bg-zinc-950 overflow-hidden"
            onClick={() => inputRef.current?.focus()}
          >
            {/* Output area */}
            <pre
              ref={termOutputRef}
              className="flex-1 overflow-y-auto [scrollbar-width:thin] [scrollbar-color:#3f3f46_transparent] px-2 py-1 font-mono text-[10px] text-green-400 whitespace-pre-wrap break-all leading-relaxed"
            >
              {termOutput ||
                (!termConnected
                  ? 'Connecting to terminal...'
                  : 'Terminal ready. Type a command below.')}
            </pre>

            {/* Input row */}
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
                placeholder={termConnected ? (termBusy ? 'running...' : 'enter command') : 'not connected'}
              />
              {termBusy && (
                <span className="text-zinc-500 font-mono text-[9px] shrink-0 animate-pulse">
                  ▋
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
