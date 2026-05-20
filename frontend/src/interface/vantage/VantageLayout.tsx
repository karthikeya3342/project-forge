import React from 'react';
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

export const VantageLayout: React.FC<VantageLayoutProps> = ({ canvasRef }) => {
  const { mainView, setMainView } = useVantageStore();

  return (
    <div className="w-screen h-screen bg-white flex flex-col overflow-hidden">
      {/* Header */}
      <Header />

      {/* Main body */}
      <div className="flex flex-row flex-1 min-h-0 overflow-hidden">
        {/* Left: File Explorer */}
        <VantageFileExplorer />

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

          {/* Canvas area (always mounted, visibility toggled) */}
          <div className="flex-1 relative min-h-0 overflow-hidden">
            {/* Three.js canvas — always in DOM so SceneManager never loses its target */}
            <div
              ref={canvasRef}
              className="absolute inset-0 bg-zinc-900"
              style={{ visibility: mainView === '3d' ? 'visible' : 'hidden' }}
            >
              <UIOverlay />
            </div>

            {/* Monaco code view — overlays canvas when in code mode */}
            {mainView === 'code' && (
              <div className="absolute inset-0 z-10">
                <VantageCodeView />
              </div>
            )}
          </div>

          {/* Console */}
          <VantageConsole />
        </div>

        {/* Right: Telemetry */}
        <VantageTelemetryPanel />
      </div>
    </div>
  );
};
