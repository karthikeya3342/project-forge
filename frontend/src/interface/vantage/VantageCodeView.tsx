import React, { useCallback, useEffect, useRef, useState } from 'react';
import Editor, { OnMount } from '@monaco-editor/react';
import { ChevronLeft, Code2, Loader2, RotateCcw, RotateCw, Save } from 'lucide-react';
import { useVantageStore } from '../../integration/store/vantageStore';
import { readFile, writeFile } from '../../integration/vantageApi';

function detectLanguage(path: string | null): string {
  if (!path) return 'plaintext';
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    py: 'python', ts: 'typescript', tsx: 'typescript',
    js: 'javascript', jsx: 'javascript', json: 'json',
    md: 'markdown', css: 'css', html: 'html',
    yaml: 'yaml', yml: 'yaml', sh: 'shell',
    txt: 'plaintext', toml: 'toml', rs: 'rust', go: 'go',
  };
  return map[ext] ?? 'plaintext';
}

export const VantageCodeView: React.FC = () => {
  const { selectedFilePath, fileContents, setFileContent, setMainView } = useVantageStore();
  const lang = detectLanguage(selectedFilePath);

  const [localContent, setLocalContent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Keep a ref to latest handleSave so Monaco's addCommand doesn't go stale
  const editorRef = useRef<any>(null);
  const handleSaveRef = useRef<() => void>(() => {});

  // Load file when selection changes
  useEffect(() => {
    if (!selectedFilePath) return;
    setSaveError(null);

    const cached = fileContents[selectedFilePath];
    if (cached !== undefined) {
      setLocalContent(cached);
      setSavedContent(cached);
      return;
    }

    setLoading(true);
    readFile(selectedFilePath)
      .then((res) => {
        const text = res.content ?? '';
        setLocalContent(text);
        setSavedContent(text);
        setFileContent(selectedFilePath, text);
      })
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFilePath]);

  // If pipeline writes this file while it's open and we have no local edits — auto-update
  useEffect(() => {
    if (!selectedFilePath) return;
    const storeVal = fileContents[selectedFilePath];
    if (storeVal !== undefined && storeVal !== savedContent && localContent === savedContent) {
      setLocalContent(storeVal);
      setSavedContent(storeVal);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileContents]);

  const handleSave = useCallback(async () => {
    if (!selectedFilePath || saving) return;
    if (localContent === savedContent) return;
    setSaving(true);
    setSaveError(null);
    const res = await writeFile(selectedFilePath, localContent);
    if (res.success) {
      setSavedContent(localContent);
      setFileContent(selectedFilePath, localContent);
    } else {
      setSaveError(res.error ?? 'Save failed');
    }
    setSaving(false);
  }, [selectedFilePath, localContent, savedContent, saving, setFileContent]);

  // Keep ref current
  useEffect(() => { handleSaveRef.current = handleSave; }, [handleSave]);

  const onMount: OnMount = (ed) => {
    editorRef.current = ed;
    // Ctrl+S / Cmd+S — KeyMod.CtrlCmd=2048, KeyCode.KeyS=49
    ed.addCommand(2048 | 49, () => handleSaveRef.current());
  };

  const isDirty = localContent !== savedContent;
  const filename = selectedFilePath?.replace(/\\/g, '/').split('/').pop() ?? '';

  return (
    <div className="flex flex-col h-full bg-white">
      {/* Tab bar */}
      <div className="h-9 flex items-center gap-1.5 px-2 border-b border-zinc-200 shrink-0 bg-zinc-50">
        <button
          onClick={() => setMainView('3d')}
          className="p-1 text-zinc-400 hover:text-zinc-600 transition-colors rounded"
        >
          <ChevronLeft size={13} />
        </button>

        <Code2 size={12} className="text-cyan-500 shrink-0" />

        <span className="text-[11px] text-zinc-700 font-mono truncate flex-1 min-w-0" title={selectedFilePath ?? ''}>
          {filename || 'No file selected'}
        </span>

        {/* Dirty dot */}
        {isDirty && (
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" title="Unsaved changes" />
        )}

        {/* Lang badge */}
        {selectedFilePath && (
          <span className="text-[9px] font-black uppercase tracking-widest text-zinc-400 shrink-0 hidden sm:inline">
            {lang}
          </span>
        )}

        {/* Toolbar */}
        {selectedFilePath && (
          <div className="flex items-center gap-0.5 ml-1 shrink-0">
            <button
              onClick={() => editorRef.current?.trigger('toolbar', 'undo', null)}
              className="p-1.5 text-zinc-400 hover:text-zinc-600 hover:bg-zinc-200 rounded transition-colors"
              title="Undo (Ctrl+Z)"
            >
              <RotateCcw size={11} />
            </button>
            <button
              onClick={() => editorRef.current?.trigger('toolbar', 'redo', null)}
              className="p-1.5 text-zinc-400 hover:text-zinc-600 hover:bg-zinc-200 rounded transition-colors"
              title="Redo (Ctrl+Y)"
            >
              <RotateCw size={11} />
            </button>
            <button
              onClick={handleSave}
              disabled={!isDirty || saving}
              className={`flex items-center gap-1 px-2.5 py-1 ml-0.5 rounded text-[10px] font-black uppercase tracking-wider transition-all ${
                isDirty
                  ? 'bg-cyan-500 hover:bg-cyan-600 text-white cursor-pointer'
                  : 'bg-zinc-100 text-zinc-300 cursor-not-allowed'
              }`}
              title="Save (Ctrl+S)"
            >
              {saving
                ? <Loader2 size={10} className="animate-spin" />
                : <Save size={10} />
              }
              Save
            </button>
          </div>
        )}
      </div>

      {/* Save error */}
      {saveError && (
        <div className="shrink-0 bg-red-50 border-b border-red-100 px-3 py-1.5 text-[10px] text-red-600 font-medium">
          {saveError}
        </div>
      )}

      {/* Editor area */}
      <div className="flex-1 min-h-0 relative">
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-white">
            <Loader2 size={20} className="text-zinc-300 animate-spin" />
          </div>
        )}

        {selectedFilePath ? (
          /* key=selectedFilePath remounts Monaco on file change — clears undo stack cleanly */
          <Editor
            key={selectedFilePath}
            height="100%"
            language={lang}
            value={localContent}
            theme="light"
            onMount={onMount}
            onChange={(val) => setLocalContent(val ?? '')}
            options={{
              readOnly: false,
              minimap: { enabled: false },
              fontSize: 12,
              lineNumbers: 'on',
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              fontFamily: '"JetBrains Mono", "Fira Code", Consolas, monospace',
              padding: { top: 12 },
              renderLineHighlight: 'line',
              overviewRulerLanes: 0,
              smoothScrolling: true,
              cursorBlinking: 'smooth',
              bracketPairColorization: { enabled: true },
              formatOnPaste: true,
            }}
          />
        ) : (
          <div className="flex flex-col items-center justify-center h-full gap-3">
            <Code2 size={28} className="text-zinc-300" />
            <p className="text-[11px] text-zinc-400 text-center">
              Click a file in the explorer to edit it
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
