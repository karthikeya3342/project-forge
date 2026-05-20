/**
 * VantageScene — Three.js 3D spatial observability canvas.
 * Agent avatars, telemetry arcs, and ambient cyber grid.
 * Pattern from arturitu/the-delegation: per-agent state machines + tick loop.
 */
import React, { useEffect, useRef } from "react";
import * as THREE from "three";
import { useStore } from "../store";
import { AgentAvatar } from "./AgentAvatar";
import type { AgentName } from "../types/telemetry";

const AGENT_NAMES: AgentName[] = ["orchestrator", "codeplan", "parsel", "swe_agent", "autocoderover"];

function buildGrid(): THREE.GridHelper {
  const grid = new THREE.GridHelper(30, 30, 0x1e293b, 0x0f172a);
  grid.position.y = -2;
  return grid;
}

function buildAmbientLight(): THREE.AmbientLight {
  return new THREE.AmbientLight(0x0a0a1a, 1);
}

function buildPointLights(): THREE.PointLight[] {
  const colors = [0x22d3ee, 0xa78bfa, 0xfb923c];
  return colors.map((c, i) => {
    const light = new THREE.PointLight(c, 2, 20);
    light.position.set(-8 + i * 8, 5, -5);
    return light;
  });
}

export default function VantageScene() {
  const mountRef = useRef<HTMLDivElement>(null);
  const agents = useStore((s) => s.agents);

  useEffect(() => {
    const mount = mountRef.current!;
    const W = mount.clientWidth;
    const H = mount.clientHeight;

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setSize(W, H);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.shadowMap.enabled = true;
    renderer.setClearColor(0x020409);
    mount.appendChild(renderer.domElement);

    // Scene
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x020409, 0.04);

    // Camera
    const camera = new THREE.PerspectiveCamera(60, W / H, 0.1, 100);
    camera.position.set(0, 6, 14);
    camera.lookAt(0, 0, 0);

    // Lights
    scene.add(buildAmbientLight());
    buildPointLights().forEach((l) => scene.add(l));
    scene.add(buildGrid());

    // Agent avatars
    const agentStore = useStore.getState().agents;
    const avatars: Record<AgentName, AgentAvatar> = {} as Record<AgentName, AgentAvatar>;
    AGENT_NAMES.forEach((name) => {
      const info = agentStore[name];
      const avatar = new AgentAvatar(name, info.color, info.position);
      avatars[name] = avatar;
      scene.add(avatar.mesh);
    });

    // Connection lines between orchestrator and agents
    const lineMat = new THREE.LineBasicMaterial({ color: 0x1e293b, transparent: true, opacity: 0.4 });
    const orchPos = new THREE.Vector3(...agentStore["orchestrator"].position);
    AGENT_NAMES.filter((n) => n !== "orchestrator").forEach((name) => {
      const agentPos = new THREE.Vector3(...agentStore[name].position);
      const geo = new THREE.BufferGeometry().setFromPoints([orchPos, agentPos]);
      scene.add(new THREE.Line(geo, lineMat));
    });

    // Subscribe to store for state changes
    const unsub = useStore.subscribe((state) => {
      AGENT_NAMES.forEach((name) => {
        avatars[name]?.setState(state.agents[name].state);
      });
    });

    // Animation loop
    const clock = new THREE.Clock();
    let animId: number;

    const animate = () => {
      animId = requestAnimationFrame(animate);
      const delta = clock.getDelta();
      AGENT_NAMES.forEach((name) => avatars[name]?.tick(delta));

      // Slow camera orbit
      const t = clock.getElapsedTime();
      camera.position.x = Math.sin(t * 0.05) * 14;
      camera.position.z = Math.cos(t * 0.05) * 14;
      camera.lookAt(0, 0, 0);

      renderer.render(scene, camera);
    };
    animate();

    // Resize handler
    const onResize = () => {
      const W2 = mount.clientWidth;
      const H2 = mount.clientHeight;
      camera.aspect = W2 / H2;
      camera.updateProjectionMatrix();
      renderer.setSize(W2, H2);
    };
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener("resize", onResize);
      unsub();
      AGENT_NAMES.forEach((n) => avatars[n]?.dispose());
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={mountRef} style={{ width: "100%", height: "100%" }} />;
}
