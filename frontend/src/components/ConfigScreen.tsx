import React, { useState } from "react";
import { useStore } from "../store";

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed", inset: 0,
    background: "#000",
    display: "flex", alignItems: "center", justifyContent: "center",
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
  },
  panel: {
    background: "#0a0a0f",
    border: "1px solid #1e293b",
    borderRadius: 8,
    padding: "48px 40px",
    width: 480,
    boxShadow: "0 0 60px rgba(34,211,238,0.08)",
  },
  title: {
    fontSize: 22,
    fontWeight: 700,
    color: "#22d3ee",
    letterSpacing: "0.12em",
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 11,
    color: "#475569",
    letterSpacing: "0.2em",
    marginBottom: 36,
  },
  label: {
    display: "block",
    fontSize: 11,
    color: "#64748b",
    letterSpacing: "0.15em",
    marginBottom: 6,
    textTransform: "uppercase" as const,
  },
  input: {
    width: "100%",
    background: "#0f172a",
    border: "1px solid #1e293b",
    borderRadius: 4,
    padding: "10px 14px",
    color: "#e2e8f0",
    fontSize: 13,
    fontFamily: "inherit",
    marginBottom: 20,
    outline: "none",
  },
  note: {
    fontSize: 11,
    color: "#334155",
    marginBottom: 28,
  },
  button: {
    width: "100%",
    padding: "12px 0",
    background: "#22d3ee",
    color: "#000",
    border: "none",
    borderRadius: 4,
    fontSize: 13,
    fontWeight: 700,
    letterSpacing: "0.1em",
    cursor: "pointer",
  },
  error: {
    color: "#f87171",
    fontSize: 12,
    marginBottom: 12,
  },
};

export default function ConfigScreen() {
  const setConfig = useStore((s) => s.setConfig);
  const [apiKey, setApiKey] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [error, setError] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKey.trim()) { setError("API key required."); return; }
    if (!workspace.trim()) { setError("Workspace path required."); return; }
    setError("");
    setConfig(apiKey.trim(), workspace.trim());
  };

  return (
    <div style={styles.overlay}>
      <div style={styles.panel}>
        <div style={styles.title}>VANTAGE</div>
        <div style={styles.subtitle}>VERIFIABLE AGENTIC NETWORK · SPATIAL OBSERVABILITY SYSTEM</div>

        <form onSubmit={handleSubmit}>
          <label style={styles.label}>Google AI Studio API Key</label>
          <input
            style={styles.input}
            type="password"
            placeholder="AIza..."
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="off"
          />

          <label style={styles.label}>Workspace Directory (absolute path)</label>
          <input
            style={styles.input}
            type="text"
            placeholder="C:\Users\YourName\Projects\AgentWorkspace"
            value={workspace}
            onChange={(e) => setWorkspace(e.target.value)}
          />
          <div style={styles.note}>
            All AI operations are strictly sandboxed to this directory via Docker volume mount.
          </div>

          {error && <div style={styles.error}>{error}</div>}

          <button style={styles.button} type="submit">
            INITIALIZE VANTAGE
          </button>
        </form>
      </div>
    </div>
  );
}
