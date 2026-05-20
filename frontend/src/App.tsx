import React, { useEffect } from "react";
import { useStore } from "./store";
import ConfigScreen from "./components/ConfigScreen";
import HITLModal from "./components/HITLModal";
import PromptBar from "./components/PromptBar";
import TelemetryLog from "./components/TelemetryLog";
import VantageScene from "./scene/VantageScene";
import { connectWebSocket } from "./ws/client";

export default function App() {
  const configured = useStore((s) => s.configured);

  useEffect(() => {
    if (configured) connectWebSocket();
  }, [configured]);

  if (!configured) return <ConfigScreen />;

  return (
    <div style={{ width: "100vw", height: "100vh", background: "#020409", position: "relative" }}>
      {/* 3D Scene — full viewport */}
      <VantageScene />

      {/* HUD overlays */}
      <TelemetryLog />
      <PromptBar />
      <HITLModal />

      {/* VANTAGE wordmark */}
      <div style={{
        position: "fixed", top: 20, left: 24,
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        fontSize: 13, fontWeight: 700, letterSpacing: "0.2em",
        color: "#22d3ee", zIndex: 100,
      }}>
        VANTAGE
      </div>
    </div>
  );
}
