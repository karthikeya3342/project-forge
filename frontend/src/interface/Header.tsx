import { Info, KeyRound, Maximize2, Settings } from 'lucide-react';
import React, { useState } from 'react';
import packageJson from '../../package.json';
import { useCoreStore } from '../integration/store/coreStore';
import { useUiStore } from '../integration/store/uiStore';
import BYOKModal from './BYOKModal';
import InfoModal from './InfoModal';

const version = packageJson.version;

const Header: React.FC = () => {
  const { llmConfig, isBYOKOpen, setBYOKOpen } = useUiStore();
  const { setViewMode } = useCoreStore();
  const [isInfoOpen, setIsInfoOpen] = useState(false);
  const hasKey = !!llmConfig.apiKey;

  const handleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen();
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen();
      }
    }
  };

  return (
    <header className="h-14 border-b border-zinc-100 flex items-center justify-between px-6 bg-white shrink-0 relative z-40">
      {/* Left: VANTAGE wordmark */}
      <div className="flex items-center gap-3 min-w-0">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-cyan-400 flex items-center justify-center shrink-0">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
          </div>
          <span className="text-[15px] font-black tracking-widest text-zinc-900 uppercase">VANTAGE</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setIsInfoOpen(true)}
            className="text-zinc-300 hover:text-zinc-500 transition-colors cursor-pointer"
          >
            <Info size={13} strokeWidth={2} />
          </button>
          <span className="text-[10px] font-medium text-zinc-400 font-mono">v{version}</span>
        </div>
      </div>

      {/* Right: Global Controls */}
      <div className="flex items-center gap-3">

        <button
          onClick={() => setViewMode('design')}
          className="flex items-center gap-2 px-3 py-1 bg-darkDelegation hover:bg-darkDelegation text-white rounded-lg transition-all shadow-lg shadow-black/10 active:scale-95 cursor-pointer h-9 shrink-0 ml-1"
          title="Manage Teams"
        >
          <Settings size={14} className="group-hover:rotate-45 transition-transform" />
          <span className="text-[10px] font-black uppercase tracking-wider ml-1 hidden sm:inline">Manage Teams</span>
        </button>

        <div className="w-px h-4 bg-zinc-200" />

        <div className="flex items-center gap-2">
          <button
            onClick={handleFullscreen}
            className="text-zinc-400 hover:text-darkDelegation transition-colors p-1"
            title="Fullscreen Browser"
          >
            <Maximize2 size={16} />
          </button>
          <button
            onClick={() => setBYOKOpen(true)}
            className="relative text-zinc-400 hover:text-darkDelegation transition-colors p-1"
            title="API Key (BYOK)"
          >
            <KeyRound size={16} className={hasKey ? 'text-emerald-500 hover:text-emerald-600' : ''} />
            {hasKey && (
              <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-emerald-400" />
            )}
          </button>
        </div>
      </div>

      {isInfoOpen && (
        <InfoModal key="info-modal" onClose={() => setIsInfoOpen(false)} />
      )}

      {isBYOKOpen && (
        <BYOKModal key="byok-modal" onClose={() => setBYOKOpen(false)} />
      )}
    </header>
  );
};

export default Header;
