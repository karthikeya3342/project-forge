import React from "react";
import { useStore } from "../store";

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "fixed", inset: 0,
    background: "rgba(0,0,0,0.85)",
    backdropFilter: "blur(4px)",
    display: "flex", alignItems: "center", justifyContent: "center",
    zIndex: 1000,
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
  },
  panel: {
    background: "#0a0a0f",
    border: "1px solid #dc2626",
    borderRadius: 8,
    padding: "36px 32px",
    width: 500,
    boxShadow: "0 0 80px rgba(220,38,38,0.2)",
  },
  badge: {
    display: "inline-block",
    background: "#7f1d1d",
    color: "#fca5a5",
    fontSize: 10,
    letterSpacing: "0.2em",
    padding: "3px 8px",
    borderRadius: 3,
    marginBottom: 16,
  },
  title: {
    fontSize: 16,
    fontWeight: 700,
    color: "#fca5a5",
    marginBottom: 12,
  },
  description: {
    fontSize: 13,
    color: "#94a3b8",
    lineHeight: 1.6,
    marginBottom: 28,
    padding: "12px 16px",
    background: "#0f172a",
    borderRadius: 4,
    border: "1px solid #1e293b",
  },
  actions: {
    display: "flex",
    gap: 12,
  },
  approveBtn: {
    flex: 1,
    padding: "11px 0",
    background: "#16a34a",
    color: "#fff",
    border: "none",
    borderRadius: 4,
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: "0.1em",
    cursor: "pointer",
    fontFamily: "inherit",
  },
  rejectBtn: {
    flex: 1,
    padding: "11px 0",
    background: "#dc2626",
    color: "#fff",
    border: "none",
    borderRadius: 4,
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: "0.1em",
    cursor: "pointer",
    fontFamily: "inherit",
  },
  typeLabel: {
    fontSize: 10,
    color: "#f87171",
    letterSpacing: "0.15em",
    marginBottom: 8,
    textTransform: "uppercase" as const,
  },
};

const HITL_LABELS: Record<string, string> = {
  file_overwrite: "CRITICAL FILE OVERWRITE DETECTED",
  vulnerability_found: "AST VULNERABILITY FLAGGED",
  unknown: "HUMAN APPROVAL REQUIRED",
};

export default function HITLModal() {
  const { hitlPending, hitlType, hitlDescription, resolveHITL } = useStore((s) => ({
    hitlPending: s.hitlPending,
    hitlType: s.hitlType,
    hitlDescription: s.hitlDescription,
    resolveHITL: s.resolveHITL,
  }));

  if (!hitlPending) return null;

  const label = HITL_LABELS[hitlType ?? "unknown"] ?? "HUMAN APPROVAL REQUIRED";

  return (
    <div style={styles.backdrop}>
      <div style={styles.panel}>
        <div style={styles.badge}>HITL CHECKPOINT</div>
        <div style={styles.typeLabel}>{label}</div>
        <div style={styles.title}>Agent execution paused — awaiting your decision</div>
        <div style={styles.description}>
          {hitlDescription ?? "The AI agent requests permission to proceed with a high-risk operation."}
        </div>
        <div style={styles.actions}>
          <button style={styles.approveBtn} onClick={() => resolveHITL(true)}>
            APPROVE &amp; CONTINUE
          </button>
          <button style={styles.rejectBtn} onClick={() => resolveHITL(false)}>
            REJECT &amp; HALT
          </button>
        </div>
      </div>
    </div>
  );
}
