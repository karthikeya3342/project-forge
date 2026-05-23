import { create } from 'zustand';

// ── Tree helpers ────────────────────────────────────────────────────────────

function _insertFile(tree: FileNode[], parts: string[], fullPath: string): FileNode[] {
  if (parts.length === 0) return tree;
  const [head, ...rest] = parts;

  if (rest.length === 0) {
    // Leaf — file node
    if (tree.some((n) => n.name === head && n.type === 'file')) return tree;
    return [...tree, { name: head, path: fullPath, type: 'file' as const }];
  }

  // Directory node
  const existing = tree.find((n) => n.name === head && n.type === 'directory');
  const dirPath = fullPath.split('/').slice(0, fullPath.split('/').length - rest.length).join('/');
  if (existing) {
    return tree.map((n) =>
      n === existing
        ? { ...n, children: _insertFile(n.children ?? [], rest, fullPath) }
        : n
    );
  }
  return [
    ...tree,
    { name: head, path: dirPath, type: 'directory' as const, children: _insertFile([], rest, fullPath) },
  ];
}

export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileNode[];
}

export interface WsLogEntry {
  ts: number;
  raw: string;
  packet: Record<string, unknown>;
}

export interface TerminalLogEntry {
  ts: number;
  output: string;
}

type MainView = '3d' | 'code';
type ConsoleTab = 'events' | 'agent-terminal' | 'terminal';
export type PlanStepStatus = 'pending' | 'working' | 'done' | 'error';

interface VantageStoreState {
  // File explorer
  fileTree: FileNode[];
  selectedFilePath: string | null;
  fileContents: Record<string, string>;
  modifyingFiles: Set<string>;

  // View
  mainView: MainView;

  // Console
  wsLog: WsLogEntry[];
  terminalLog: TerminalLogEntry[];
  consoleTab: ConsoleTab;

  // Pipeline
  currentNode: string;
  nodeHistory: string[];
  dependencyMap: Record<string, string[]>;

  // Live streaming
  streamingAgent: string;
  streamingText: string;

  // 3D agent bubble text (real-time status over NPC heads)
  agentBubbleText: Record<string, string>;
  // Focused agent index (clicked NPC in VANTAGE mode)
  focusedAgentIndex: number | null;

  // Plan approval gate
  executionPlan: string[];
  planApprovalPending: boolean;
  planStepStatuses: Record<number, PlanStepStatus>;
  activeWorkerCount: number;
  terminalOutput: string;

  // Actions
  setFileTree: (tree: FileNode[]) => void;
  setSelectedFilePath: (path: string | null) => void;
  setFileContent: (path: string, content: string) => void;
  setModifyingFile: (path: string, modifying: boolean) => void;
  setMainView: (view: MainView) => void;
  appendWsLog: (entry: WsLogEntry) => void;
  appendTerminalLog: (entry: TerminalLogEntry) => void;
  setConsoleTab: (tab: ConsoleTab) => void;
  setCurrentNode: (node: string) => void;
  setDependencyMap: (map: Record<string, string[]>) => void;
  appendStreamingChunk: (agent: string, chunk: string) => void;
  clearStreamingText: () => void;
  setAgentBubbleText: (agent: string, text: string) => void;
  clearAgentBubbleText: (agent: string) => void;
  setFocusedAgentIndex: (index: number | null) => void;
  upsertFileInTree: (path: string) => void;
  setExecutionPlan: (plan: string[]) => void;
  setPlanApprovalPending: (v: boolean) => void;
  setPlanStepStatus: (idx: number, status: PlanStepStatus) => void;
  setActiveWorkerCount: (n: number) => void;
  appendTerminalOutput: (chunk: string) => void;
  clearTerminalOutput: () => void;
  reset: () => void;
}

const INITIAL: Omit<
  VantageStoreState,
  | 'setFileTree'
  | 'setSelectedFilePath'
  | 'setFileContent'
  | 'setModifyingFile'
  | 'setMainView'
  | 'appendWsLog'
  | 'appendTerminalLog'
  | 'setConsoleTab'
  | 'setCurrentNode'
  | 'setDependencyMap'
  | 'appendStreamingChunk'
  | 'clearStreamingText'
  | 'setAgentBubbleText'
  | 'clearAgentBubbleText'
  | 'setFocusedAgentIndex'
  | 'upsertFileInTree'
  | 'setExecutionPlan'
  | 'setPlanApprovalPending'
  | 'setPlanStepStatus'
  | 'setActiveWorkerCount'
  | 'appendTerminalOutput'
  | 'clearTerminalOutput'
  | 'reset'
> = {
  fileTree: [],
  selectedFilePath: null,
  fileContents: {},
  modifyingFiles: new Set<string>(),
  mainView: '3d',
  wsLog: [],
  terminalLog: [],
  consoleTab: 'events',
  currentNode: '',
  nodeHistory: [],
  dependencyMap: {},
  streamingAgent: '',
  streamingText: '',
  agentBubbleText: {},
  focusedAgentIndex: null,
  executionPlan: [],
  planApprovalPending: false,
  planStepStatuses: {},
  activeWorkerCount: 0,
  terminalOutput: '',
};

export const useVantageStore = create<VantageStoreState>()((set) => ({
  ...INITIAL,

  setFileTree: (tree) => set({ fileTree: tree }),

  setSelectedFilePath: (path) => set({ selectedFilePath: path }),

  setFileContent: (path, content) =>
    set((s) => ({ fileContents: { ...s.fileContents, [path]: content } })),

  setModifyingFile: (path, modifying) =>
    set((s) => {
      const next = new Set(s.modifyingFiles);
      if (modifying) next.add(path);
      else next.delete(path);
      return { modifyingFiles: next };
    }),

  setMainView: (view) => set({ mainView: view }),

  appendWsLog: (entry) =>
    set((s) => ({ wsLog: [...s.wsLog.slice(-499), entry] })),

  appendTerminalLog: (entry) =>
    set((s) => ({ terminalLog: [...s.terminalLog.slice(-499), entry] })),

  setConsoleTab: (tab) => set({ consoleTab: tab }),

  setCurrentNode: (node) =>
    set((s) => ({
      currentNode: node,
      nodeHistory: [...s.nodeHistory, node].slice(-50),
    })),

  setDependencyMap: (map) => set({ dependencyMap: map }),

  appendStreamingChunk: (agent, chunk) =>
    set((s) => ({
      streamingAgent: agent,
      streamingText: s.streamingText + chunk,
    })),

  clearStreamingText: () => set({ streamingAgent: '', streamingText: '' }),

  setAgentBubbleText: (agent, text) =>
    set((s) => ({ agentBubbleText: { ...s.agentBubbleText, [agent]: text } })),

  clearAgentBubbleText: (agent) =>
    set((s) => {
      const copy = { ...s.agentBubbleText };
      delete copy[agent];
      return { agentBubbleText: copy };
    }),

  setFocusedAgentIndex: (index) => set({ focusedAgentIndex: index }),

  upsertFileInTree: (path) =>
    set((s) => ({ fileTree: _insertFile(s.fileTree, path.replace(/\\/g, '/').split('/'), path.replace(/\\/g, '/')) })),

  setExecutionPlan: (plan) => set({ executionPlan: plan, planStepStatuses: {} }),

  setPlanApprovalPending: (v) => set({ planApprovalPending: v }),

  setPlanStepStatus: (idx, status) =>
    set((s) => ({ planStepStatuses: { ...s.planStepStatuses, [idx]: status } })),

  setActiveWorkerCount: (n) => set({ activeWorkerCount: n }),

  appendTerminalOutput: (chunk) =>
    set((s) => ({ terminalOutput: s.terminalOutput + chunk })),

  clearTerminalOutput: () => set({ terminalOutput: '' }),

  reset: () =>
    set({
      ...INITIAL,
      modifyingFiles: new Set<string>(),
      planStepStatuses: {},
      executionPlan: [],
      planApprovalPending: false,
      activeWorkerCount: 0,
      terminalOutput: '',
    }),
}));
