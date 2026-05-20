import React, { useState } from 'react';
import { Zap, Loader2 } from 'lucide-react';
import { useUiStore } from '../integration/store/uiStore';
import { useCoreStore } from '../integration/store/coreStore';
import { startVantagePipeline } from '../integration/vantageApi';
import { connectVantageWs } from '../integration/vantageWs';

export const VantageLaunchPanel: React.FC = () => {
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const { llmConfig, setVantageSessionId, setBYOKOpen } = useUiStore() as any;
  const addLogEntry = useCoreStore((s) => s.addLogEntry);

  const handleLaunch = async () => {
    const apiKey = llmConfig?.apiKey || '';
    const workspacePath = llmConfig?.workspacePath || '';

    if (!prompt.trim()) { setError('Enter a task description.'); return; }
    if (!apiKey) { setBYOKOpen(true, 'API key required for VANTAGE.'); return; }
    if (!workspacePath) { setBYOKOpen(true, 'Workspace path required for VANTAGE.'); return; }

    setError('');
    setLoading(true);

    connectVantageWs();

    try {
      const result = await startVantagePipeline(prompt.trim(), workspacePath, apiKey);
      if ('error' in result) {
        setError(result.error);
      } else {
        setVantageSessionId(result.session_id);
        addLogEntry({ agentIndex: 0, action: `VANTAGE pipeline started: ${prompt.trim()}` });
        setPrompt('');
      }
    } catch (e) {
      setError('Backend unreachable. Is the VANTAGE backend running on :8000?');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2"
      style={{ width: 580 }}
    >
      <div className="flex-1 bg-zinc-950/95 border border-zinc-800 rounded-2xl shadow-2xl shadow-black/50 backdrop-blur-sm overflow-hidden">
        {error && (
          <div className="px-4 pt-3 text-[11px] text-red-400 font-mono">{error}</div>
        )}
        <div className="flex items-center gap-2 px-4 py-3">
          <Zap size={14} className="text-cyan-400 shrink-0" />
          <input
            type="text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !loading && handleLaunch()}
            placeholder="Describe what VANTAGE agents should build..."
            disabled={loading}
            className="flex-1 bg-transparent text-sm text-zinc-100 placeholder:text-zinc-600 font-mono focus:outline-none"
          />
          <button
            onClick={handleLaunch}
            disabled={loading || !prompt.trim()}
            className="flex items-center gap-1.5 px-4 py-1.5 bg-cyan-500 hover:bg-cyan-400 disabled:bg-zinc-800 disabled:text-zinc-600 text-black disabled:text-zinc-600 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all active:scale-95 shrink-0"
          >
            {loading
              ? <><Loader2 size={12} className="animate-spin" /> Running</>
              : <><Zap size={12} /> Execute</>
            }
          </button>
        </div>
      </div>
    </div>
  );
};
