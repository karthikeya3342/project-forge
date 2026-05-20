import type { TelemetryPacket, AgentName } from "../types/telemetry";
import { useStore } from "../store";

let socket: WebSocket | null = null;

export function connectWebSocket() {
  if (socket?.readyState === WebSocket.OPEN) return;

  socket = new WebSocket("ws://localhost:8000/ws");

  socket.onopen = () => {
    console.log("[VANTAGE] WebSocket connected");
  };

  socket.onmessage = (event) => {
    try {
      const packet: TelemetryPacket = JSON.parse(event.data as string);
      const store = useStore.getState();

      // Update agent state in store
      if (packet.agent) {
        store.updateAgent(packet.agent as AgentName, {
          state: packet.state,
          message: packet.message,
        });
      }

      // Push to telemetry log
      store.pushLog({ ...packet, timestamp: new Date().toISOString() });

      // Handle special packet types
      switch (packet.type) {
        case "hitl_required":
          store.setHITL(packet.hitl_type ?? "unknown", packet.message);
          break;
        case "pipeline_done":
          store.setPipelineStatus("complete");
          break;
        case "pipeline_error":
          store.setPipelineStatus("error");
          break;
        default:
          if (packet.state === "waiting_approval") {
            store.setHITL(packet.hitl_type ?? "unknown", packet.message);
          }
      }
    } catch {
      // non-JSON message — ignore
    }
  };

  socket.onclose = () => {
    console.log("[VANTAGE] WebSocket disconnected — reconnecting in 3s");
    setTimeout(connectWebSocket, 3000);
  };

  socket.onerror = () => {
    socket?.close();
  };
}

export function disconnectWebSocket() {
  socket?.close();
  socket = null;
}
