/**
 * AgentAvatar — 3D representation of a VANTAGE agent.
 * Borrowed state-machine pattern from arturitu/the-delegation.
 *
 * Geometry per agent:
 *   orchestrator  → TorusKnot  (complex, central)
 *   codeplan      → Octahedron (mapper, sharp)
 *   parsel        → Icosahedron (decomposer, faceted)
 *   swe_agent     → Box        (builder, solid)
 *   autocoderover → Dodecahedron (auditor, many faces)
 */
import * as THREE from "three";
import type { AgentName, AgentState } from "../types/telemetry";

const STATE_EMISSIVE: Record<AgentState, number> = {
  idle:             0x111111,
  working:          0x224466,
  complete:         0x003322,
  error:            0x661111,
  waiting_approval: 0x664400,
};

const STATE_INTENSITY: Record<AgentState, number> = {
  idle:             0.1,
  working:          1.2,
  complete:         0.6,
  error:            2.0,
  waiting_approval: 1.8,
};

function makeGeometry(name: AgentName): THREE.BufferGeometry {
  switch (name) {
    case "orchestrator":  return new THREE.TorusKnotGeometry(0.6, 0.2, 100, 16);
    case "codeplan":      return new THREE.OctahedronGeometry(0.8);
    case "parsel":        return new THREE.IcosahedronGeometry(0.8);
    case "swe_agent":     return new THREE.BoxGeometry(1.2, 1.2, 1.2);
    case "autocoderover": return new THREE.DodecahedronGeometry(0.8);
  }
}

export class AgentAvatar {
  mesh: THREE.Mesh;
  label: THREE.Sprite;
  private material: THREE.MeshStandardMaterial;
  private baseColor: THREE.Color;
  private rotationSpeed: number;
  private _state: AgentState = "idle";
  private pulsePhase = 0;

  constructor(name: AgentName, color: string, position: [number, number, number]) {
    this.baseColor = new THREE.Color(color);
    this.rotationSpeed = 0.005 + Math.random() * 0.005;

    this.material = new THREE.MeshStandardMaterial({
      color: this.baseColor,
      emissive: new THREE.Color(STATE_EMISSIVE["idle"]),
      emissiveIntensity: STATE_INTENSITY["idle"],
      roughness: 0.3,
      metalness: 0.8,
      wireframe: false,
    });

    this.mesh = new THREE.Mesh(makeGeometry(name), this.material);
    this.mesh.position.set(...position);
    this.mesh.castShadow = true;

    // Wireframe overlay for cyber aesthetic
    const wireGeo = makeGeometry(name);
    const wireMat = new THREE.MeshBasicMaterial({
      color: this.baseColor,
      wireframe: true,
      transparent: true,
      opacity: 0.15,
    });
    const wire = new THREE.Mesh(wireGeo, wireMat);
    this.mesh.add(wire);

    this.label = this._makeLabel(name);
    this.mesh.add(this.label);
  }

  private _makeLabel(name: string): THREE.Sprite {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, 256, 64);
    ctx.fillStyle = "#22d3ee";
    ctx.font = "bold 24px monospace";
    ctx.textAlign = "center";
    ctx.fillText(name.toUpperCase(), 128, 40);
    const texture = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: texture, transparent: true });
    const sprite = new THREE.Sprite(mat);
    sprite.position.set(0, 1.6, 0);
    sprite.scale.set(2, 0.5, 1);
    return sprite;
  }

  setState(state: AgentState) {
    if (this._state === state) return;
    this._state = state;
    this.material.emissive.setHex(STATE_EMISSIVE[state]);
    this.material.emissiveIntensity = STATE_INTENSITY[state];
    this.rotationSpeed = state === "working" ? 0.025 : 0.005;
  }

  tick(delta: number) {
    this.pulsePhase += delta;

    if (this._state === "working") {
      this.mesh.rotation.y += this.rotationSpeed;
      this.mesh.rotation.x += this.rotationSpeed * 0.4;
      const pulse = 0.8 + Math.sin(this.pulsePhase * 4) * 0.2;
      this.mesh.scale.setScalar(pulse);
    } else if (this._state === "error") {
      // Flash red
      const flash = Math.sin(this.pulsePhase * 12) > 0;
      this.material.emissiveIntensity = flash ? 2.5 : 0.5;
      this.mesh.rotation.y += 0.002;
      this.mesh.scale.setScalar(1);
    } else if (this._state === "waiting_approval") {
      const pulse = 1 + Math.sin(this.pulsePhase * 3) * 0.1;
      this.mesh.scale.setScalar(pulse);
      this.mesh.rotation.y += 0.008;
    } else {
      this.mesh.rotation.y += this.rotationSpeed;
      this.mesh.scale.setScalar(1);
    }
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
