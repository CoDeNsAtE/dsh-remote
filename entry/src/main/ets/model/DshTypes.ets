export interface DshAgentInfo {
  name?: string;
  version?: string;
}

export interface DshHelloInfo {
  name: string;
  version: string;
  pathValue: string;
  workspace: string;
  defaultCwd: string;
  online: boolean;
  agentName: string;
  agentVersion: string;
}

export interface DshRpcError {
  code?: number;
  message?: string;
}

export interface DshSessionSummary {
  sessionId: string;
  cwd: string;
  title: string;
  preview: string;
  createdAt: number;
  updatedAt: number;
  running: boolean;
  hasTranscript: boolean;
}

@Observed
export class DshChatItem {
  id: string = '';
  kind: string = 'notice';
  text: string = '';
  time: number = 0;
  title: string = '';
  label: string = '';
  status: string = '';
  toolCallId: string = '';
  input: string = '';
  result: string = '';
  collapsed: boolean = false;
}

export interface DshConfigChoice {
  value: string;
  name: string;
  group: string;
  description: string;
}

export interface DshConfigOption {
  id: string;
  name: string;
  category: string;
  type: string;
  currentValue: string;
  choices: DshConfigChoice[];
}

export interface DshApprovalOption {
  optionId: string;
  name: string;
  kind: string;
}

export interface DshApprovalRequest {
  requestId: string;
  sessionId: string;
  toolCallId: string;
  title: string;
  label: string;
  input: string;
  options: DshApprovalOption[];
}

export interface DshRpcPayload {
  sessions?: DshSessionSummary[];
  online?: boolean;
  warning?: string;
  session?: DshSessionSummary;
  items?: DshChatItem[];
  configOptions?: DshConfigOption[];
  attached?: boolean;
  stopReason?: string;
  ok?: boolean;
  time?: number;
}

export interface DshWireFrame {
  type: string;
  id?: string;
  event?: string;
  result?: DshRpcPayload;
  error?: DshRpcError;
  message?: string;
  name?: string;
  version?: string;
  path?: string;
  workspace?: string;
  defaultCwd?: string;
  online?: boolean;
  agent?: DshAgentInfo;
  capabilities?: Object;
  sessionId?: string;
  item?: DshChatItem;
  session?: DshSessionSummary;
  requestId?: string;
  toolCallId?: string;
  title?: string;
  label?: string;
  input?: string;
  options?: DshApprovalOption[];
  decision?: string;
  optionId?: string;
  reason?: string;
  status?: string;
  stopReason?: string;
  used?: number;
  size?: number;
  configOptions?: DshConfigOption[];
}

export interface DshRpcParams {
  sessionId?: string;
  cwd?: string;
  text?: string;
  configId?: string;
  value?: string;
  requestId?: string;
  optionId?: string;
}

export interface DshSessionsResult {
  sessions: DshSessionSummary[];
  online: boolean;
  warning: string;
}

export interface DshOpenResult {
  session: DshSessionSummary;
  items: DshChatItem[];
  configOptions: DshConfigOption[];
  attached: boolean;
  warning: string;
}

export interface DshTextSegment {
  key: string;
  kind: string;
  content: string;
  lang: string;
}

export interface DshConfigRow {
  rowKey: string;
  rowKind: string;
  rowLabel: string;
  configId: string;
  choiceValue: string;
  selected: boolean;
}

export class DshChatParams {
  sessionId: string;
  cwd: string;
  sessionTitle: string;

  constructor(sessionId: string, cwd: string, sessionTitle: string) {
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.sessionTitle = sessionTitle;
  }
}

export class DshDefaults {
  static hello(): DshHelloInfo {
    const info: DshHelloInfo = {
      name: 'dsh-mobile-bridge',
      version: '',
      pathValue: '/dsh',
      workspace: '',
      defaultCwd: '',
      online: false,
      agentName: 'deepseek-harness-acp',
      agentVersion: ''
    };
    return info;
  }

  static session(): DshSessionSummary {
    const value: DshSessionSummary = {
      sessionId: '',
      cwd: '',
      title: '会话',
      preview: '',
      createdAt: 0,
      updatedAt: 0,
      running: false,
      hasTranscript: false
    };
    return value;
  }

  static chatItem(): DshChatItem {
    return new DshChatItem();
  }

  static configOption(): DshConfigOption {
    const value: DshConfigOption = {
      id: '',
      name: '',
      category: '',
      type: '',
      currentValue: '',
      choices: []
    };
    return value;
  }

  static approvalOption(): DshApprovalOption {
    const value: DshApprovalOption = {
      optionId: '',
      name: '',
      kind: ''
    };
    return value;
  }

  static approval(): DshApprovalRequest {
    const value: DshApprovalRequest = {
      requestId: '',
      sessionId: '',
      toolCallId: '',
      title: '',
      label: '',
      input: '',
      options: []
    };
    return value;
  }

  static rpcPayload(): DshRpcPayload {
    const value: DshRpcPayload = {};
    return value;
  }

  static textSegment(): DshTextSegment {
    const value: DshTextSegment = {
      key: '',
      kind: 'text',
      content: '',
      lang: ''
    };
    return value;
  }
}
