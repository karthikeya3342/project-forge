/**
 * VantagePlanView — Notion-style execution plan with approval gate.
 *
 * Shows after CodePlan finishes:
 *   □ Step 1: Create src/main.py     ← pending
 *   ⟳ Step 2: Add auth middleware    ← working (spinner)
 *   ✓ Step 3: Write tests            ← done (strikethrough)
 *
 * "Approve & Execute" button resumes the paused pipeline.
 * Collapses to a summary once all steps complete.
 */
import React, { useState } from 'react';
import {
  CheckCircle2,
  Circle,
  Loader2,
  Zap,
  XCircle,
  ChevronDown,
  ChevronRight,
  AlertCircle,
} from 'lucide-react';
import { useVantageStore } from '../../integration/store/vantageStore';
import { useUiStore } from '../../integration/store/uiStore';
import { approvePlan } from '../../integration/vantageApi';

export const VantagePlanView: React.FC = () => {
  const {
    executionPlan,
    planApprovalPending,
    planStepStatuses,
    activeWorkerCount,
    setPlanApprovalPending,
    setPlanStepStatus,
  } = useVantageStore();

  const { vantageSessionId } = useUiStore() as any;
  const [approving, setApproving] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  if (!executionPlan.length) return null;

  const doneCount = executionPlan.filter((_, i) => planStepStatuses[i] === 'done').length;
  const allDone = doneCount === executionPlan.length;

  const handleApprove = async () => {
    if (!vantageSessionId || approving) return;
    setApproving(true);
    setPlanApprovalPending(false);
    await approvePlan(vantageSessionId, true);
    setApproving(false);
  };

  const handleReject = async () => {
    if (!vantageSessionId) return;
    setPlanApprovalPending(false);
    await approvePlan(vantageSessionId, false);
  };

  // ── Collapsed summary (all done) ─────────────────────────────────────────
  if (allDone && !planApprovalPending) {
    return (
      <div className="mx-3 my-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <CheckCircle2 size={12} className="text-emerald-500 shrink-0" />
          <span className="text-[10px] font-bold text-emerald-700">
            All {executionPlan.length} steps complete
          </span>
        </div>
        <button
          onClick={() => setCollapsed((v) => !v)}
          className="text-emerald-400 hover:text-emerald-600 transition-colors"
        >
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        </button>
      </div>
    );
  }

  return (
    <div className="mx-3 my-2 rounded-xl border border-zinc-200 bg-zinc-50 overflow-hidden shrink-0">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-200">
        <div className="flex items-center gap-2">
          {planApprovalPending ? (
            <AlertCircle size={10} className="text-amber-500 shrink-0" />
          ) : activeWorkerCount > 0 ? (
            <Loader2 size={10} className="text-cyan-500 animate-spin shrink-0" />
          ) : (
            <CheckCircle2 size={10} className="text-zinc-400 shrink-0" />
          )}
          <span className="text-[9px] font-black uppercase tracking-[0.15em] text-zinc-500">
            {planApprovalPending
              ? 'Awaiting Approval'
              : activeWorkerCount > 0
              ? `${activeWorkerCount} worker${activeWorkerCount > 1 ? 's' : ''} running`
              : `${doneCount} / ${executionPlan.length} steps done`}
          </span>
        </div>
        <button
          onClick={() => setCollapsed((v) => !v)}
          className="text-zinc-300 hover:text-zinc-500 transition-colors"
        >
          {collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
        </button>
      </div>

      {!collapsed && (
        <>
          {/* ── Step list ────────────────────────────────────────────────── */}
          <div className="px-3 py-2 space-y-1.5 max-h-48 overflow-y-auto [scrollbar-width:thin]">
            {executionPlan.map((step, i) => {
              const status = planStepStatuses[i] ?? 'pending';
              const isDone = status === 'done';
              const isWorking = status === 'working';
              const isError = status === 'error';
              // Strip "Step N:" prefix if present
              const cleanStep = step.replace(/^Step\s*\d+:\s*/i, '').trim();

              return (
                <div key={i} className="flex items-start gap-2">
                  {/* Status icon */}
                  <div className="mt-0.5 shrink-0">
                    {isDone ? (
                      <CheckCircle2 size={10} className="text-emerald-500" />
                    ) : isWorking ? (
                      <Loader2 size={10} className="text-cyan-500 animate-spin" />
                    ) : isError ? (
                      <AlertCircle size={10} className="text-red-400" />
                    ) : (
                      <Circle size={10} className="text-zinc-300" />
                    )}
                  </div>

                  {/* Step text */}
                  <span
                    className={`text-[10px] leading-snug transition-all ${
                      isDone
                        ? 'line-through text-zinc-400'
                        : isWorking
                        ? 'text-zinc-800 font-semibold'
                        : isError
                        ? 'text-red-500'
                        : 'text-zinc-500'
                    }`}
                  >
                    {cleanStep}
                  </span>
                </div>
              );
            })}
          </div>

          {/* ── Approve / Reject buttons (only when pending) ─────────────── */}
          {planApprovalPending && (
            <div className="px-3 pb-3 flex gap-2">
              <button
                onClick={handleApprove}
                disabled={approving}
                className="flex-1 flex items-center justify-center gap-1.5 py-2 bg-zinc-900 hover:bg-zinc-700 disabled:opacity-60 text-white rounded-xl text-[10px] font-black uppercase tracking-widest transition-all active:scale-95"
              >
                {approving ? (
                  <Loader2 size={10} className="animate-spin" />
                ) : (
                  <Zap size={10} />
                )}
                {approving ? 'Starting…' : 'Approve & Execute'}
              </button>
              <button
                onClick={handleReject}
                className="flex items-center justify-center gap-1 px-3 py-2 bg-white hover:bg-red-50 border border-zinc-200 hover:border-red-200 text-zinc-400 hover:text-red-500 rounded-xl text-[10px] transition-all active:scale-95"
                title="Reject plan"
              >
                <XCircle size={10} />
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
};
