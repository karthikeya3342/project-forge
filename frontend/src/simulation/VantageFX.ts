/**
 * VantageFX — Visual effects for VANTAGE pipeline visualization.
 *
 * 1. Pipeline beams: glowing bezier lines between agents showing data flow
 * 2. Progress ring: floating spinning torus around active agent
 * 3. Ground glow: subtle pulsing circle under working agents
 * 4. File cards: floating labels above agents showing current file being edited
 * 5. Status board: floating 3D panel summarizing pipeline progress
 * 6. Error explosion: particle burst when pipeline/agent errors occur
 *
 * All meshes added/removed from scene dynamically.
 */
import * as THREE from 'three/webgpu';

// Pipeline order: orchestrator → codeplan → parsel → swe_agent → autocoderover
const PIPELINE_ORDER = [1, 2, 3, 4, 5];

const AGENT_NAMES: Record<number, string> = {
  1: 'Orchestrator',
  2: 'CodePlan',
  3: 'Parsel',
  4: 'SWE-Agent',
  5: 'AutoCodeRover',
};

// Agent colors (match frontend theme)
const AGENT_GLOW_COLORS: Record<number, number> = {
  1: 0xfacc15, // orchestrator — yellow
  2: 0x06b6d4, // codeplan — cyan
  3: 0x8b5cf6, // parsel — violet
  4: 0xf97316, // swe_agent — orange
  5: 0xec4899, // autocoderover — pink
};

// ── Canvas texture helper ────────────────────────────────────────────────────

function createTextSprite(
  text: string,
  opts: {
    fontSize?: number;
    color?: string;
    bgColor?: string;
    padding?: number;
    maxWidth?: number;
    borderRadius?: number;
  } = {},
): THREE.Sprite {
  const {
    fontSize = 28,
    color = '#ffffff',
    bgColor = 'rgba(24,24,27,0.85)',
    padding = 16,
    maxWidth = 512,
    borderRadius = 14,
  } = opts;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  ctx.font = `bold ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace`;
  const metrics = ctx.measureText(text);
  const textWidth = Math.min(metrics.width, maxWidth);

  canvas.width = textWidth + padding * 2;
  canvas.height = fontSize + padding * 2;

  // Background
  ctx.fillStyle = bgColor;
  _roundRect(ctx, 0, 0, canvas.width, canvas.height, borderRadius);
  ctx.fill();

  // Text
  ctx.font = `bold ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace`;
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, padding, canvas.height / 2, maxWidth);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;

  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
  });
  const sprite = new THREE.Sprite(material);

  // Scale to world units (roughly 1 unit per 100px)
  const scale = 0.01;
  sprite.scale.set(canvas.width * scale, canvas.height * scale, 1);

  return sprite;
}

function _roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ── Status board texture ─────────────────────────────────────────────────────

function createStatusBoardTexture(
  stages: { name: string; status: 'idle' | 'working' | 'complete' | 'error' }[],
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 480;
  canvas.height = 320;
  const ctx = canvas.getContext('2d')!;

  // Background
  ctx.fillStyle = 'rgba(9,9,11,0.92)';
  _roundRect(ctx, 0, 0, canvas.width, canvas.height, 20);
  ctx.fill();

  // Border
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 2;
  _roundRect(ctx, 1, 1, canvas.width - 2, canvas.height - 2, 20);
  ctx.stroke();

  // Title
  ctx.font = 'bold 22px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.fillText('VANTAGE PIPELINE', 24, 40);

  // Divider
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(24, 56);
  ctx.lineTo(canvas.width - 24, 56);
  ctx.stroke();

  // Stages
  const statusColors: Record<string, string> = {
    idle: '#71717a',
    working: '#06b6d4',
    complete: '#10b981',
    error: '#ef4444',
  };
  const statusLabels: Record<string, string> = {
    idle: 'WAITING',
    working: 'RUNNING',
    complete: 'DONE',
    error: 'ERROR',
  };

  stages.forEach((stage, i) => {
    const y = 80 + i * 52;

    // Status dot
    ctx.fillStyle = statusColors[stage.status] ?? '#71717a';
    ctx.beginPath();
    ctx.arc(36, y + 8, 6, 0, Math.PI * 2);
    ctx.fill();

    // Glow for working
    if (stage.status === 'working') {
      ctx.fillStyle = `${statusColors.working}44`;
      ctx.beginPath();
      ctx.arc(36, y + 8, 12, 0, Math.PI * 2);
      ctx.fill();
    }

    // Name
    ctx.font = 'bold 20px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillStyle = stage.status === 'working' ? '#ffffff' : 'rgba(255,255,255,0.6)';
    ctx.fillText(stage.name, 56, y + 14);

    // Status badge
    const badgeColor = statusColors[stage.status] ?? '#71717a';
    const badgeText = statusLabels[stage.status] ?? 'IDLE';
    ctx.font = 'bold 14px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace';
    const badgeW = ctx.measureText(badgeText).width + 16;
    const badgeX = canvas.width - 24 - badgeW;

    ctx.fillStyle = `${badgeColor}22`;
    _roundRect(ctx, badgeX, y - 4, badgeW, 24, 8);
    ctx.fill();
    ctx.fillStyle = badgeColor;
    ctx.fillText(badgeText, badgeX + 8, y + 12);
  });

  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

// ── Particle for error explosion ─────────────────────────────────────────────

interface Particle {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  life: number;
  maxLife: number;
}

// ══════════════════════════════════════════════════════════════════════════════

export class VantageFX {
  private scene: THREE.Scene;
  private beams: THREE.Line[] = [];
  private progressRing: THREE.Mesh | null = null;
  private groundGlows: Map<number, THREE.Mesh> = new Map();
  private activeAgentIdx: number | null = null;
  private elapsed = 0;

  // File cards — floating labels above agents
  private fileCards: Map<number, THREE.Sprite> = new Map();

  // Status board — floating panel in scene
  private statusBoard: THREE.Sprite | null = null;
  private statusBoardPosition = new THREE.Vector3(0, 3.5, 0);
  private stageStatuses: Map<string, 'idle' | 'working' | 'complete' | 'error'> = new Map();

  // Error explosion particles
  private particles: Particle[] = [];

  // Cache agent positions (updated each frame from SceneManager)
  private agentPositions: Map<number, THREE.Vector3> = new Map();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    // Initialize stage statuses
    ['CodePlan', 'Parsel', 'SWE-Agent', 'AutoCodeRover'].forEach(
      (n) => this.stageStatuses.set(n, 'idle'),
    );
  }

  // ── Position sync ──────────────────────────────────────────────────────────

  /** Update agent world positions — call each frame with CPU positions */
  updatePositions(cpuPos: Float32Array, count: number) {
    for (const idx of PIPELINE_ORDER) {
      if (idx < count) {
        const x = cpuPos[idx * 4];
        const y = cpuPos[idx * 4 + 1];
        const z = cpuPos[idx * 4 + 2];
        let v = this.agentPositions.get(idx);
        if (!v) {
          v = new THREE.Vector3();
          this.agentPositions.set(idx, v);
        }
        v.set(x, y, z);
      }
    }
  }

  // ── 1. Pipeline beams ──────────────────────────────────────────────────────

  /** Show pipeline beam from agent A → agent B */
  showBeam(fromIdx: number, toIdx: number) {
    const fromPos = this.agentPositions.get(fromIdx);
    const toPos = this.agentPositions.get(toIdx);
    if (!fromPos || !toPos) return;

    const points = [
      fromPos.clone().add(new THREE.Vector3(0, 1.5, 0)),
      new THREE.Vector3(
        (fromPos.x + toPos.x) / 2,
        Math.max(fromPos.y, toPos.y) + 2.5,
        (fromPos.z + toPos.z) / 2,
      ),
      toPos.clone().add(new THREE.Vector3(0, 1.5, 0)),
    ];

    const curve = new THREE.QuadraticBezierCurve3(points[0], points[1], points[2]);
    const curvePoints = curve.getPoints(20);
    const geometry = new THREE.BufferGeometry().setFromPoints(curvePoints);

    const color = AGENT_GLOW_COLORS[toIdx] ?? 0x34d399;
    const material = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: 0.6,
      linewidth: 2,
    });

    const line = new THREE.Line(geometry, material);
    this.scene.add(line);
    this.beams.push(line);
  }

  /** Show beams for the current pipeline progress (up to activeIdx) */
  showPipelineBeams(currentAgentName: string) {
    this.clearBeams();

    const nameToIdx: Record<string, number> = {
      orchestrator: 1, codeplan: 2, parsel: 3, swe_agent: 4, autocoderover: 5,
    };
    const currentIdx = nameToIdx[currentAgentName];
    if (!currentIdx) return;

    const orderPos = PIPELINE_ORDER.indexOf(currentIdx);
    for (let i = 0; i < orderPos; i++) {
      this.showBeam(PIPELINE_ORDER[i], PIPELINE_ORDER[i + 1]);
    }
  }

  clearBeams() {
    for (const beam of this.beams) {
      this.scene.remove(beam);
      beam.geometry.dispose();
      (beam.material as THREE.Material).dispose();
    }
    this.beams = [];
  }

  // ── 2. Progress ring ───────────────────────────────────────────────────────

  setActiveAgent(idx: number | null) {
    if (this.activeAgentIdx === idx) return;

    if (this.progressRing) {
      this.scene.remove(this.progressRing);
      this.progressRing.geometry.dispose();
      (this.progressRing.material as THREE.Material).dispose();
      this.progressRing = null;
    }

    this.activeAgentIdx = idx;

    if (idx !== null) {
      const color = AGENT_GLOW_COLORS[idx] ?? 0x34d399;
      const geometry = new THREE.TorusGeometry(0.4, 0.04, 8, 32, Math.PI * 1.6);
      const material = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.6,
        side: THREE.DoubleSide,
      });
      this.progressRing = new THREE.Mesh(geometry, material);
      this.progressRing.rotation.x = Math.PI / 2;
      const pos = this.agentPositions.get(idx);
      if (pos) this.progressRing.position.set(pos.x, pos.y + 2.2, pos.z);
      this.scene.add(this.progressRing);
    }
  }

  // ── 3. Ground glow ─────────────────────────────────────────────────────────

  addGroundGlow(idx: number) {
    if (this.groundGlows.has(idx)) return;

    const color = AGENT_GLOW_COLORS[idx] ?? 0x34d399;
    const geometry = new THREE.CircleGeometry(0.6, 32);
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.25,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0.02;
    this.scene.add(mesh);
    this.groundGlows.set(idx, mesh);
  }

  removeGroundGlow(idx: number) {
    const mesh = this.groundGlows.get(idx);
    if (mesh) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      this.groundGlows.delete(idx);
    }
  }

  // ── 4. File cards — floating labels showing current file ───────────────────

  /** Show a file card floating above an agent */
  showFileCard(agentIdx: number, filename: string) {
    this.removeFileCard(agentIdx);

    // Shorten long paths: "src/components/MyComponent.tsx" → "MyComponent.tsx"
    const short = filename.includes('/')
      ? '📄 ' + filename.split('/').pop()!
      : '📄 ' + filename;

    const color = AGENT_GLOW_COLORS[agentIdx];
    const hexColor = color ? `#${color.toString(16).padStart(6, '0')}` : '#34d399';

    const sprite = createTextSprite(short, {
      fontSize: 22,
      color: hexColor,
      bgColor: 'rgba(9,9,11,0.88)',
      padding: 12,
      borderRadius: 10,
    });

    const pos = this.agentPositions.get(agentIdx);
    if (pos) sprite.position.set(pos.x, pos.y + 2.8, pos.z);

    this.scene.add(sprite);
    this.fileCards.set(agentIdx, sprite);
  }

  removeFileCard(agentIdx: number) {
    const existing = this.fileCards.get(agentIdx);
    if (existing) {
      this.scene.remove(existing);
      (existing.material as THREE.SpriteMaterial).map?.dispose();
      existing.material.dispose();
      this.fileCards.delete(agentIdx);
    }
  }

  clearFileCards() {
    for (const idx of [...this.fileCards.keys()]) {
      this.removeFileCard(idx);
    }
  }

  // ── 5. Status board — floating panel showing pipeline summary ──────────────

  /** Update + render the status board. Call when pipeline state changes. */
  updateStatusBoard(currentAgentName: string, completedAgents: string[]) {
    const nameToDisplay: Record<string, string> = {
      codeplan: 'CodePlan', parsel: 'Parsel', swe_agent: 'SWE-Agent', autocoderover: 'AutoCodeRover',
    };

    // Update statuses
    for (const [display] of this.stageStatuses) {
      this.stageStatuses.set(display, 'idle');
    }
    for (const name of completedAgents) {
      const d = nameToDisplay[name];
      if (d) this.stageStatuses.set(d, 'complete');
    }
    const currentDisplay = nameToDisplay[currentAgentName];
    if (currentDisplay) this.stageStatuses.set(currentDisplay, 'working');

    // Remove old board
    if (this.statusBoard) {
      this.scene.remove(this.statusBoard);
      (this.statusBoard.material as THREE.SpriteMaterial).map?.dispose();
      this.statusBoard.material.dispose();
      this.statusBoard = null;
    }

    // Build stage list
    const stages = ['CodePlan', 'Parsel', 'SWE-Agent', 'AutoCodeRover'].map((name) => ({
      name,
      status: this.stageStatuses.get(name) ?? 'idle' as const,
    }));

    const texture = createStatusBoardTexture(stages);
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
    });
    this.statusBoard = new THREE.Sprite(material);
    this.statusBoard.scale.set(4.8, 3.2, 1);

    // Position: find center of all agents and place board above/behind
    const positions = [...this.agentPositions.values()];
    if (positions.length >= 2) {
      const center = new THREE.Vector3();
      positions.forEach((p) => center.add(p));
      center.divideScalar(positions.length);
      this.statusBoardPosition.set(center.x, 4.5, center.z - 3);
    }
    this.statusBoard.position.copy(this.statusBoardPosition);
    this.scene.add(this.statusBoard);
  }

  /** Mark agent as errored on the board */
  setAgentError(agentName: string) {
    const nameToDisplay: Record<string, string> = {
      codeplan: 'CodePlan', parsel: 'Parsel', swe_agent: 'SWE-Agent', autocoderover: 'AutoCodeRover',
    };
    const d = nameToDisplay[agentName];
    if (d) this.stageStatuses.set(d, 'error');
  }

  removeStatusBoard() {
    if (this.statusBoard) {
      this.scene.remove(this.statusBoard);
      (this.statusBoard.material as THREE.SpriteMaterial).map?.dispose();
      this.statusBoard.material.dispose();
      this.statusBoard = null;
    }
  }

  // ── 6. Error explosion — particle burst ────────────────────────────────────

  /** Spawn particle burst at agent position */
  triggerErrorExplosion(agentIdx: number) {
    const pos = this.agentPositions.get(agentIdx);
    if (!pos) return;

    const origin = pos.clone().add(new THREE.Vector3(0, 1.5, 0));
    const count = 24;

    for (let i = 0; i < count; i++) {
      const geometry = new THREE.SphereGeometry(0.04, 6, 6);
      const material = new THREE.MeshBasicMaterial({
        color: i % 3 === 0 ? 0xef4444 : i % 3 === 1 ? 0xfbbf24 : 0xf97316,
        transparent: true,
        opacity: 1,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.copy(origin);
      this.scene.add(mesh);

      // Random outward velocity
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.random() * Math.PI;
      const speed = 1.5 + Math.random() * 3;
      const velocity = new THREE.Vector3(
        Math.sin(phi) * Math.cos(theta) * speed,
        Math.cos(phi) * speed * 0.8 + 2,
        Math.sin(phi) * Math.sin(theta) * speed,
      );

      this.particles.push({
        mesh,
        velocity,
        life: 0,
        maxLife: 0.8 + Math.random() * 0.6,
      });
    }
  }

  // ── Frame update ───────────────────────────────────────────────────────────

  update(delta: number) {
    this.elapsed += delta;

    // Progress ring animation
    if (this.progressRing && this.activeAgentIdx !== null) {
      const pos = this.agentPositions.get(this.activeAgentIdx);
      if (pos) {
        this.progressRing.position.set(
          pos.x,
          pos.y + 2.2 + Math.sin(this.elapsed * 2) * 0.08,
          pos.z,
        );
        this.progressRing.rotation.z += delta * 1.5;
      }
      const mat = this.progressRing.material as THREE.MeshBasicMaterial;
      mat.opacity = 0.5 + Math.sin(this.elapsed * 3) * 0.15;
    }

    // Ground glow positions + pulse
    for (const [idx, mesh] of this.groundGlows) {
      const pos = this.agentPositions.get(idx);
      if (pos) {
        mesh.position.set(pos.x, 0.02, pos.z);
        const mat = mesh.material as THREE.MeshBasicMaterial;
        mat.opacity = 0.2 + Math.sin(this.elapsed * 2 + idx) * 0.1;
      }
    }

    // Beam pulse
    for (const beam of this.beams) {
      const mat = beam.material as THREE.LineBasicMaterial;
      mat.opacity = 0.4 + Math.sin(this.elapsed * 2.5) * 0.2;
    }

    // File card positions (float above agent + gentle bob)
    for (const [idx, sprite] of this.fileCards) {
      const pos = this.agentPositions.get(idx);
      if (pos) {
        sprite.position.set(
          pos.x,
          pos.y + 2.8 + Math.sin(this.elapsed * 1.5 + idx * 0.5) * 0.05,
          pos.z,
        );
      }
    }

    // Status board gentle float
    if (this.statusBoard) {
      this.statusBoard.position.y = this.statusBoardPosition.y + Math.sin(this.elapsed * 0.8) * 0.06;
    }

    // Particles (error explosion)
    const gravity = -6;
    const deadParticles: number[] = [];
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      p.life += delta;
      if (p.life >= p.maxLife) {
        deadParticles.push(i);
        continue;
      }
      // Physics
      p.velocity.y += gravity * delta;
      p.mesh.position.addScaledVector(p.velocity, delta);
      // Fade out
      const t = p.life / p.maxLife;
      (p.mesh.material as THREE.MeshBasicMaterial).opacity = 1 - t * t;
      // Shrink
      const scale = 1 - t * 0.6;
      p.mesh.scale.setScalar(scale);
    }
    // Remove dead particles (reverse to preserve indices)
    for (let i = deadParticles.length - 1; i >= 0; i--) {
      const idx = deadParticles[i];
      const p = this.particles[idx];
      this.scene.remove(p.mesh);
      p.mesh.geometry.dispose();
      (p.mesh.material as THREE.Material).dispose();
      this.particles.splice(idx, 1);
    }
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────

  clearAll() {
    this.clearBeams();
    this.setActiveAgent(null);
    this.clearFileCards();
    this.removeStatusBoard();
    for (const idx of [...this.groundGlows.keys()]) {
      this.removeGroundGlow(idx);
    }
    // Kill particles
    for (const p of this.particles) {
      this.scene.remove(p.mesh);
      p.mesh.geometry.dispose();
      (p.mesh.material as THREE.Material).dispose();
    }
    this.particles = [];
    // Reset stage statuses
    for (const [key] of this.stageStatuses) {
      this.stageStatuses.set(key, 'idle');
    }
  }

  dispose() {
    this.clearAll();
  }
}
