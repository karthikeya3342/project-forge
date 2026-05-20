import React, { useState } from "react";
import { useStore } from "../store";

const styles: Record<string, React.CSSProperties> = {
  bar: {
    position: "fixed",
    bottom: 24,
    left: "50%",
    transform: "translateX(-50%)",
    display: "flex",
    gap: 8,
    width: 640,
    zIndex: 100,
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
  },
  input: {
    flex: 1,
    background: "rgba(10,10,15,0.9)",
    border: "1px solid #1e293b",
    borderRadius: 4,
    padding: "12px 16px",
    color: "#e2e8f0",
    fontSize: 13,
    fontFamily: "inherit",
    outline: "none",
    backdropFilter: "blur(8px)",
  },
  button: {
    padding: "12px 20px",
    background: "#22d3ee",
    color: "#000",
    border: "none",
    borderRadius: 4,
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: "0.08em",
    cursor: "pointer",
    fontFamily: "inherit",
    whiteSpace: "nowrap" as const,
  },
  disabledButton: {
    padding: "12px 20px",
    background: "#1e293b",
    color: "#475569",
    border: "none",
    borderRadius: 4,
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: "0.08em",
    cursor: "not-allowed",
    fontFamily: "inherit",
    whiteSpace: "nowrap" as const,
  },
  status: {
    position: "fixed",
    bottom: 80,
    left: "50%",
    transform: "translateX(-50%)",
    fontSize: 11,
    color: "#475569",
    letterSpacing: "0.1em",
    zIndex: 100,
    fontFamily: "inherit",
  },
};

const STATUS_COLORS: Record<string, string> = {
  idle: "#475569",
  running: "#22d3ee",
  hitl_pause: "#fb923c",
  complete: "#22c55e",
  error: "#ef4444",
};

export default function PromptBar() {
  const [prompt, setPrompt] = useState("");
  const { startPipeline, pipelineStatus } = useStore((s) => ({
    startPipeline: s.startPipeline,
    pipelineStatus: s.pipelineStatus,
  }));

  const running = pipelineStatus === "running" || pipelineStatus === "hitl_pause";
  const statusColor = STATUS_COLORS[pipelineStatus] ?? "#475569";

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || running) return;
    startPipeline(prompt.trim());
    setPrompt("");
  };

  return (
    <>
      <div style={{ ...styles.status, color: statusColor }}>
        STATUS: {pipelineStatus.toUpperCase().replace("_", " ")}
      </div>
      <form style={styles.bar} onSubmit={handleSubmit}>
        <input
          style={styles.input}
          type="text"
          placeholder="Describe what you want the agent network to build..."
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          disabled={running}
        />
        <button
          style={running ? styles.disabledButton : styles.button}
          type="submit"
          disabled={running}
        >
          {running ? "RUNNING..." : "EXECUTE"}
        </button>
      </form>
    </>
  );
}
