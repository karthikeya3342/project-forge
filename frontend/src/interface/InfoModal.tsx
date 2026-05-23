import React from 'react';
import { X, GitBranch, Zap, ShieldCheck, Users } from 'lucide-react';

interface InfoModalProps {
  onClose: () => void;
}

const InfoModal: React.FC<InfoModalProps> = ({ onClose }) => {
  return (
    <div className="fixed inset-0 z-100 flex items-center justify-center p-6 pointer-events-auto overflow-hidden">
      <div
        onClick={onClose}
        className="absolute inset-0 bg-white/60 backdrop-blur-xl animate-in fade-in duration-500"
      />
      <div className="relative w-full max-w-xl bg-white rounded-[40px] shadow-[0_32px_64px_-12px_rgba(0,0,0,0.1)] p-8 md:p-10 border border-zinc-100 animate-in fade-in slide-in-from-bottom-4 duration-500">
        <button
          onClick={onClose}
          className="absolute top-6 right-6 p-2 text-zinc-300 hover:text-zinc-500 hover:bg-zinc-100 rounded-full transition-all active:scale-95 cursor-pointer"
        >
          <X size={20} strokeWidth={2.5} />
        </button>

        <div className="max-w-md mx-auto">
          {/* Wordmark */}
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 rounded-xl bg-cyan-400 flex items-center justify-center shrink-0">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
              </svg>
            </div>
            <div>
              <h2 className="text-2xl font-black text-zinc-900 tracking-widest uppercase">FORGE</h2>
              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-zinc-400">Multi-Agent AI Code System</p>
            </div>
          </div>

          <p className="text-zinc-500 text-[14px] leading-relaxed mb-6">
            FORGE is a trustworthy AI software engineering platform. Spawn parallel agents, watch them work in a live 3D scene, approve plans before execution, and get verified, git-committed code — not just suggestions.
          </p>

          {/* Feature pills */}
          <div className="grid grid-cols-2 gap-3 mb-8">
            <div className="flex items-start gap-2.5 p-3 bg-zinc-50 rounded-2xl">
              <Users size={14} className="text-cyan-500 mt-0.5 shrink-0" />
              <div>
                <p className="text-[10px] font-black uppercase tracking-wider text-zinc-700">Parallel Agents</p>
                <p className="text-[10px] text-zinc-400 mt-0.5">Up to 5 workers, real-time 3D visualization</p>
              </div>
            </div>
            <div className="flex items-start gap-2.5 p-3 bg-zinc-50 rounded-2xl">
              <ShieldCheck size={14} className="text-emerald-500 mt-0.5 shrink-0" />
              <div>
                <p className="text-[10px] font-black uppercase tracking-wider text-zinc-700">Trust Pillars</p>
                <p className="text-[10px] text-zinc-400 mt-0.5">Diffs, verification, git history, quality gates</p>
              </div>
            </div>
            <div className="flex items-start gap-2.5 p-3 bg-zinc-50 rounded-2xl">
              <Zap size={14} className="text-amber-500 mt-0.5 shrink-0" />
              <div>
                <p className="text-[10px] font-black uppercase tracking-wider text-zinc-700">Plan Gate</p>
                <p className="text-[10px] text-zinc-400 mt-0.5">Review & approve before any code runs</p>
              </div>
            </div>
            <div className="flex items-start gap-2.5 p-3 bg-zinc-50 rounded-2xl">
              <GitBranch size={14} className="text-purple-500 mt-0.5 shrink-0" />
              <div>
                <p className="text-[10px] font-black uppercase tracking-wider text-zinc-700">Git Native</p>
                <p className="text-[10px] text-zinc-400 mt-0.5">Every task auto-committed, fully reversible</p>
              </div>
            </div>
          </div>

          <a
            href="https://github.com/karthikeya3342/project-vantage"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-2.5 px-8 py-3.5 bg-zinc-100 text-zinc-600 rounded-xl text-[11px] font-black uppercase tracking-[0.2em] hover:bg-zinc-200 transition-all active:scale-95 cursor-pointer shadow-sm"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
            View on GitHub
          </a>
        </div>
      </div>
    </div>
  );
};

export default InfoModal;
