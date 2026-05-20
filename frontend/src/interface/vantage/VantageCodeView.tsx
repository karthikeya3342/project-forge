import React from 'react';
import Editor from '@monaco-editor/react';
import { Code2, ChevronLeft } from 'lucide-react';
import { useVantageStore } from '../../integration/store/vantageStore';

function detectLanguage(path: string | null): string {
  if (!path) return 'plaintext';
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    py: 'python',
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    json: 'json',
    md: 'markdown',
    css: 'css',
    html: 'html',
    yaml: 'yaml',
    yml: 'yaml',
    sh: 'shell',
    txt: 'plaintext',
    toml: 'toml',
    rs: 'rust',
    go: 'go',
  };
  return map[ext] ?? 'plaintext';
}

export const VantageCodeView: React.FC = () => {
  const { selectedFilePath, fileContents, setMainView } = useVantageStore();
  const content = selectedFilePath ? (fileContents[selectedFilePath] ?? '') : '';
  const lang = detectLanguage(selectedFilePath);

  return (
    <div className="flex flex-col h-full bg-zinc-950">
      {/* Tab bar */}
      <div className="h-9 flex items-center gap-2 px-3 border-b border-zinc-800/60 shrink-0 bg-zinc-900">
        <button
          onClick={() => setMainView('3d')}
          className="flex items-center gap-1 text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          <ChevronLeft size={13} />
        </button>
        <Code2 size={12} className="text-cyan-500 shrink-0" />
        <span className="text-[11px] text-zinc-300 font-mono truncate">
          {selectedFilePath ?? 'No file selected'}
        </span>
        {selectedFilePath && (
          <span className="ml-auto text-[9px] font-black uppercase tracking-widest text-zinc-600">
            {lang}
          </span>
        )}
      </div>

      {/* Editor */}
      <div className="flex-1 min-h-0">
        {selectedFilePath ? (
          <Editor
            height="100%"
            language={lang}
            value={content}
            theme="vs-dark"
            options={{
              readOnly: true,
              minimap: { enabled: false },
              fontSize: 12,
              lineNumbers: 'on',
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              fontFamily: '"JetBrains Mono", "Fira Code", Consolas, monospace',
              padding: { top: 12 },
              renderLineHighlight: 'none',
              overviewRulerLanes: 0,
            }}
          />
        ) : (
          <div className="flex flex-col items-center justify-center h-full gap-3">
            <Code2 size={28} className="text-zinc-700" />
            <p className="text-[11px] text-zinc-600 text-center">
              Click a file in the explorer to view it
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
