import React, { useState, useEffect } from 'react';
import { ChevronRight, ChevronDown, File, Folder, FolderOpen, Loader2 } from 'lucide-react';
import { useVantageStore, FileNode } from '../../integration/store/vantageStore';
import { useUiStore } from '../../integration/store/uiStore';
import { fetchWorkspaceTree } from '../../integration/vantageApi';

const EXT_COLORS: Record<string, string> = {
  py: '#3b82f6',
  ts: '#06b6d4',
  tsx: '#06b6d4',
  js: '#f59e0b',
  jsx: '#f59e0b',
  json: '#a78bfa',
  md: '#6b7280',
  css: '#ec4899',
  html: '#f97316',
  txt: '#6b7280',
};

function fileColor(name: string): string {
  const ext = name.split('.').pop() ?? '';
  return EXT_COLORS[ext] ?? '#9ca3af';
}

interface NodeProps {
  node: FileNode;
  depth: number;
}

const FileTreeNode: React.FC<NodeProps> = ({ node, depth }) => {
  const [open, setOpen] = useState(depth < 2);
  const { selectedFilePath, modifyingFiles, setSelectedFilePath, setMainView } = useVantageStore();
  const isSelected = selectedFilePath === node.path;
  const isModifying = modifyingFiles.has(node.path);

  if (node.type === 'directory') {
    return (
      <div>
        <button
          className="w-full flex items-center gap-1 px-2 py-0.5 rounded hover:bg-zinc-100 transition-colors text-left"
          style={{ paddingLeft: `${8 + depth * 12}px` }}
          onClick={() => setOpen((o) => !o)}
        >
          <span className="text-zinc-400 shrink-0">
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </span>
          <span className="text-zinc-500 shrink-0">
            {open ? <FolderOpen size={13} /> : <Folder size={13} />}
          </span>
          <span className="text-zinc-700 text-[11px] font-medium truncate ml-0.5">
            {node.name}
          </span>
        </button>
        {open && node.children?.map((child) => (
          <FileTreeNode key={child.path} node={child} depth={depth + 1} />
        ))}
      </div>
    );
  }

  return (
    <button
      className={`w-full flex items-center gap-1.5 px-2 py-0.5 rounded transition-colors text-left group ${
        isSelected
          ? 'bg-cyan-50 border border-cyan-300'
          : 'hover:bg-zinc-100 border border-transparent'
      }`}
      style={{ paddingLeft: `${8 + depth * 12}px` }}
      onClick={() => {
        setSelectedFilePath(node.path);
        setMainView('code');
      }}
    >
      {isModifying ? (
        <Loader2 size={12} className="text-cyan-400 shrink-0 animate-spin" />
      ) : (
        <File size={12} className="shrink-0" style={{ color: fileColor(node.name) }} />
      )}
      <span
        className={`text-[11px] truncate ${
          isModifying ? 'text-cyan-300' : isSelected ? 'text-cyan-700' : 'text-zinc-700 group-hover:text-zinc-900'
        }`}
      >
        {node.name}
      </span>
      {isModifying && (
        <span className="ml-auto text-[9px] text-cyan-500 uppercase tracking-widest font-black shrink-0">
          writing
        </span>
      )}
    </button>
  );
};

export const VantageFileExplorer: React.FC = () => {
  const { fileTree } = useVantageStore();
  const { llmConfig } = useUiStore() as any;
  const setFileTree = useVantageStore((s) => s.setFileTree);

  useEffect(() => {
    const wp = llmConfig?.workspacePath;
    if (!wp) return;
    fetchWorkspaceTree(wp).then((res) => {
      if (res.tree && res.tree.length > 0) {
        setFileTree(res.tree);
      }
    });
  }, [llmConfig?.workspacePath]);

  return (
    <div className="w-56 h-full bg-white border-r border-zinc-200 flex flex-col overflow-hidden shrink-0">
      {/* Header */}
      <div className="h-9 flex items-center px-3 border-b border-zinc-200 shrink-0">
        <span className="text-[9px] font-black uppercase tracking-[0.2em] text-zinc-400">
          Workspace
        </span>
      </div>

      {/* Tree */}
      <div className="flex-1 overflow-y-auto py-1 [scrollbar-width:none]">
        {fileTree.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 px-4">
            <Folder size={20} className="text-zinc-400" />
            <p className="text-[10px] text-zinc-500 text-center leading-relaxed">
              No files yet.<br />Start a task to see workspace.
            </p>
          </div>
        ) : (
          fileTree.map((node) => (
            <FileTreeNode key={node.path} node={node} depth={0} />
          ))
        )}
      </div>
    </div>
  );
};
