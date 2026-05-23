import { create } from 'zustand';

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
type ConsoleTab = 'events' | 'terminal';
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
  setExecutionPlan: (plan: string[]) => void;
  setPlanApprovalPending: (v: boolean) => void;
  setPlanStepStatus: (idx: number, status: PlanStepStatus) => void;
  setActiveWorkerCount: (n: number) => void;
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
  | 'setExecutionPlan'
  | 'setPlanApprovalPending'
  | 'setPlanStepStatus'
  | 'setActiveWorkerCount'
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

  setExecutionPlan: (plan) => set({ executionPlan: plan, planStepStatuses: {} }),

  setPlanApprovalPending: (v) => set({ planApprovalPending: v }),

  setPlanStepStatus: (idx, status) =>
    set((s) => ({ planStepStatuses: { ...s.planStepStatuses, [idx]: status } })),

  setActiveWorkerCount: (n) => set({ activeWorkerCount: n }),

  reset: () =>
    set({
      ...INITIAL,
      modifyingFiles: new Set<string>(),
      planStepStatuses: {},
      executionPlan: [],
      planApprovalPending: false,
      activeWorkerCount: 0,
    }),
}));
