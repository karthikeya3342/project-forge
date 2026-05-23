import React, { useCallback, useRef, useState } from 'react';
import { Cpu, Box } from 'lucide-react';
import Header from '../Header';
import UIOverlay from '../UIOverlay';
import { VantageFileExplorer } from './VantageFileExplorer';
import { VantageCodeView } from './VantageCodeView';
import { VantageConsole } from './VantageConsole';
import { VantageTelemetryPanel } from './VantageTelemetryPanel';
import { useVantageStore } from '../../integration/store/vantageStore';

interface VantageLayoutProps {
  canvasRef: React.RefObject<HTMLDivElement>;
}

function useDragResize(
  initial: number,
  min: number,
  max: number,
  axis: 'x' | 'y',
  invert = false,
) {
  const [size, setSize] = useState(initial);
  const ref = useRef<{ start: number; startSize: number } | null>(null);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const pos = axis === 'x' ? e.clientX : e.clientY;
      ref.current = { start: pos, startSize: size };

      const onMove = (ev: MouseEvent) => {
        if (!ref.current) return;
        const curr = axis === 'x' ? ev.clientX : ev.clientY;
        const delta = invert ? ref.current.start - curr : curr - ref.current.start;
        setSize(Math.max(min, Math.min(max, ref.current.startSize + delta)));
      };
      const onUp = () => {
        ref.current = null;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [size, axis, invert, min, max],
  );

  return [size, onMouseDown] as const;
}

export const VantageLayout: React.FC<VantageLayoutProps> = ({ canvasRef }) => {
  const { mainView, setMainView } = useVantageStore();

  // Vertical: console height (drag up = bigger)
  const [consoleHeight, onConsoleDrag] = useDragResize(176, 80, 600, 'y', true);
  // Horizontal: explorer width (drag right = bigger)
  const [explorerWidth, onExplorerDrag] = useDragResize(224, 120, 480, 'x');
  // Horizontal: telemetry width (drag left = bigger, so invert)
  const [telemetryWidth, onTelemetryDrag] = useDragResize(320, 160, 560, 'x', true);

  return (
    <div className="w-screen h-screen bg-white flex flex-col overflow-hidden">
      {/* Header */}
      <Header />

      {/* Main body */}
      <div className="flex flex-row flex-1 min-h-0 overflow-hidden">

        {/* Left: File Explorer — resizable width */}
        <div style={{ width: explorerWidth }} className="shrink-0 h-full overflow-hidden flex">
          <div className="flex-1 overflow-hidden">
            <VantageFileExplorer />
          </div>
        </div>

        {/* Drag handle: explorer ↔ center */}
        <div
          onMouseDown={onExplorerDrag}
          className="w-1.5 h-full cursor-col-resize bg-zinc-100 hover:bg-cyan-400 active:bg-cyan-500 transition-colors shrink-0"
          title="Drag to resize explorer"
        />

        {/* Center: canvas / code + console */}
        <div className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden">
          {/* View toggle bar */}
          <div className="h-9 flex items-center gap-1 px-3 border-b border-zinc-200 bg-white shrink-0">
            <button
              onClick={() => setMainView('3d')}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${
                mainView === '3d'
                  ? 'bg-zinc-100 text-zinc-900'
                  : 'text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100'
              }`}
            >
              <Box size={11} />
              3D Scene
            </button>
            <button
              onClick={() => setMainView('code')}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${
                mainView === 'code'
                  ? 'bg-zinc-100 text-zinc-900'
                  : 'text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100'
              }`}
            >
              <Cpu size={11} />
              Code View
            </button>
          </div>

          {/* Canvas area */}
          <div className="flex-1 relative min-h-0 overflow-hidden">
            <div
              ref={canvasRef}
              className="absolute inset-0 bg-zinc-900"
              style={{ visibility: mainView === '3d' ? 'visible' : 'hidden' }}
            >
              <UIOverlay />
            </div>
            {mainView === 'code' && (
              <div className="absolute inset-0 z-10">
                <VantageCodeView />
              </div>
            )}
          </div>

          {/* Drag handle: canvas ↔ console */}
          <div
            onMouseDown={onConsoleDrag}
            className="h-1.5 shrink-0 cursor-row-resize bg-zinc-100 hover:bg-cyan-400 active:bg-cyan-500 transition-colors"
            title="Drag to resize console"
          />

          {/* Console */}
          <div style={{ height: consoleHeight }} className="shrink-0 overflow-hidden flex flex-col">
            <VantageConsole />
          </div>
        </div>

        {/* Drag handle: center ↔ telemetry */}
        <div
          onMouseDown={onTelemetryDrag}
          className="w-1.5 h-full cursor-col-resize bg-zinc-100 hover:bg-cyan-400 active:bg-cyan-500 transition-colors shrink-0"
          title="Drag to resize panel"
        />

        {/* Right: Telemetry — resizable width */}
        <div style={{ width: telemetryWidth }} className="shrink-0 h-full overflow-hidden">
          <VantageTelemetryPanel />
        </div>

      </div>
    </div>
  );
};
