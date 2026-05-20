import React from 'react';
import { AlertTriangle, CheckCircle2, XCircle, ShieldCheck } from 'lucide-react';
import { useUiStore } from '../integration/store/uiStore';
import { resolveHITL } from '../integration/vantageApi';
import { addAlwaysAllowed } from '../integration/vantageAlwaysAllow';

const HITL_TITLES: Record<string, string> = {
  file_overwrite: 'Critical File Overwrite Detected',
  vulnerability_found: 'AST Vulnerability Flagged',
  dangerous_command: 'Destructive Command Detected',
  unknown: 'Human Approval Required',
};

export const VantageHITLOverlay: React.FC = () => {
  const { vantageHitl, setVantageHitl, vantageSessionId } = useUiStore() as any;

  if (!vantageHitl) return null;

  const title = HITL_TITLES[vantageHitl.type] ?? 'Human Approval Required';

  const handleApprove = async () => {
    if (vantageSessionId) await resolveHITL(vantageSessionId, true);
    setVantageHitl(null);
  };

  const handleReject = async () => {
    if (vantageSessionId) await resolveHITL(vantageSessionId, false);
    setVantageHitl(null);
  };

  const handleAlwaysAllow = async () => {
    addAlwaysAllowed(vantageHitl.type);
    if (vantageSessionId) await resolveHITL(vantageSessionId, true);
    setVantageHitl(null);
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />

      <div className="relative w-full max-w-lg bg-zinc-950 border border-red-900/60 rounded-2xl shadow-2xl shadow-red-950/50 p-8 font-mono">
        {/* Header */}
        <div className="flex items-center gap-3 mb-4">
          <AlertTriangle size={20} className="text-red-400 shrink-0" />
          <div>
            <span className="text-[9px] font-black uppercase tracking-[0.25em] text-red-500 block mb-0.5">
              VANTAGE · HITL CHECKPOINT
            </span>
            <h2 className="text-white font-black text-base tracking-tight">{title}</h2>
          </div>
        </div>

        {/* Description */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 mb-6 text-sm text-zinc-400 leading-relaxed">
          {vantageHitl.description}
        </div>

        {/* Actions */}
        <div className="flex gap-2">
          <button
            onClick={handleApprove}
            className="flex-1 flex items-center justify-center gap-2 py-3 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-[11px] font-black uppercase tracking-widest transition-all active:scale-95"
          >
            <CheckCircle2 size={14} />
            Approve
          </button>
          <button
            onClick={handleAlwaysAllow}
            className="flex-1 flex items-center justify-center gap-2 py-3 bg-cyan-700 hover:bg-cyan-600 text-white rounded-xl text-[11px] font-black uppercase tracking-widest transition-all active:scale-95"
            title={`Always approve "${vantageHitl.type}" without asking`}
          >
            <ShieldCheck size={14} />
            Always Allow
          </button>
          <button
            onClick={handleReject}
            className="flex-1 flex items-center justify-center gap-2 py-3 bg-red-700 hover:bg-red-600 text-white rounded-xl text-[11px] font-black uppercase tracking-widest transition-all active:scale-95"
          >
            <XCircle size={14} />
            Reject
          </button>
        </div>
      </div>
    </div>
  );
};
