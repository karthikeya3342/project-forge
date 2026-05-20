import React, { useEffect, useRef } from 'react';
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
  const { wsLog, terminalLog, consoleTab, setConsoleTab } = useVantageStore();
  const eventsEndRef = useRef<HTMLDivElement>(null);
  const termEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    eventsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [wsLog]);

  useEffect(() => {
    termEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [terminalLog]);

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
          {terminalLog.length > 0 && (
            <span className="bg-zinc-100 text-zinc-500 px-1 rounded text-[9px]">
              {terminalLog.length}
            </span>
          )}
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto [scrollbar-width:thin] [scrollbar-color:theme(colors.zinc.300)_transparent]">
        {consoleTab === 'events' ? (
          <div className="py-1 font-mono">
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
          <div className="py-1 font-mono">
            {terminalLog.length === 0 ? (
              <p className="text-[10px] text-zinc-400 px-3 py-2">No terminal output yet.</p>
            ) : (
              terminalLog.map((entry, i) => (
                <div key={i} className="px-3 py-0.5">
                  <span className="text-zinc-400 text-[9px] mr-2">
                    {fmtTime(entry.ts)}
                  </span>
                  <span className="text-green-400 text-[10px] whitespace-pre-wrap">
                    {entry.output}
                  </span>
                </div>
              ))
            )}
            <div ref={termEndRef} />
          </div>
        )}
      </div>
    </div>
  );
};
