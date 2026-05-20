import React, { useEffect, useRef } from "react";
import { useStore } from "../store";

const AGENT_COLORS: Record<string, string> = {
  orchestrator: "#facc15",
  codeplan: "#22d3ee",
  parsel: "#a78bfa",
  swe_agent: "#fb923c",
  autocoderover: "#f472b6",
};

const STATE_COLORS: Record<string, string> = {
  idle: "#475569",
  working: "#22d3ee",
  complete: "#22c55e",
  error: "#ef4444",
  waiting_approval: "#fb923c",
};

const styles: Record<string, React.CSSProperties> = {
  panel: {
    position: "fixed",
    top: 20,
    right: 20,
    width: 320,
    maxHeight: 420,
    background: "rgba(10,10,15,0.92)",
    border: "1px solid #1e293b",
    borderRadius: 6,
    display: "flex",
    flexDirection: "column",
    zIndex: 100,
    backdropFilter: "blur(8px)",
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
  },
  header: {
    padding: "8px 14px",
    borderBottom: "1px solid #1e293b",
    fontSize: 10,
    color: "#475569",
    letterSpacing: "0.2em",
  },
  list: {
    overflowY: "auto" as const,
    flex: 1,
    padding: "6px 0",
  },
  entry: {
    padding: "5px 14px",
    fontSize: 11,
    lineHeight: 1.5,
    borderBottom: "1px solid #0f172a",
  },
  agent: {
    fontWeight: 700,
    fontSize: 10,
    letterSpacing: "0.1em",
  },
  message: {
    color: "#94a3b8",
    marginTop: 1,
    wordBreak: "break-word" as const,
  },
};

export default function TelemetryLog() {
  const log = useStore((s) => s.log);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [log.length]);

  return (
    <div style={styles.panel}>
      <div style={styles.header}>TELEMETRY LOG</div>
      <div style={styles.list}>
        {log.map((entry, i) => (
          <div key={i} style={styles.entry}>
            <span style={{ ...styles.agent, color: AGENT_COLORS[entry.agent] ?? "#e2e8f0" }}>
              {entry.agent?.toUpperCase()}
            </span>
            {" "}
            <span style={{ fontSize: 9, color: STATE_COLORS[entry.state] ?? "#475569" }}>
              [{entry.state}]
            </span>
            <div style={styles.message}>{entry.message}</div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
