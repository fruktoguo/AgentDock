/** 前端共享类型：与后端 API payload 保持字段兼容。 */
export type AgentStatus = "idle" | "running" | "failed";
export type AgentRole = "user" | "assistant" | "system";
export type AgentId = "codex" | "claude" | "opencode" | "hermes" | "qwen" | "kimi" | "goose";
export type AgentEventKind =
  | "message"
  | "reasoning"
  | "tool"
  | "lifecycle"
  | "usage"
  | "error"
  | "plan"
  | "dispatch";

export type Backend = "orchestrator" | "cli" | "api";
export type ProviderFormat = "openai-chat" | "openai-responses" | "anthropic";

export type RunnerRef =
  | { kind: "orchestrator" }
  | { kind: "cli"; agent: AgentId }
  | { kind: "api"; provider: string; model: string };

export type RunnerOption = {
  id: string;
  ref: RunnerRef;
  backend: Backend;
  label: string;
  group: string;
  capabilityHint?: string;
  available: boolean;
  detail?: string;
};

export type SanitizedProvider = {
  id: string;
  label?: string;
  format: ProviderFormat;
  baseUrl?: string;
  apiKeyEnv?: string;
  models: string[];
  hasKey: boolean;
  apiKeyMasked: string | null;
};

export type AgentMessage = {
  id: string;
  role: AgentRole;
  content: string;
  createdAt: string;
};

export type AgentEvent = {
  id: string;
  sessionId: string;
  kind: AgentEventKind;
  title: string;
  body: string;
  status?: "started" | "updated" | "completed" | "failed";
  rawType?: string;
  /** 产出该事件的 runner 展示名。 */
  source?: string;
  /** 编排模式下所属子任务 id。 */
  group?: string;
  createdAt: string;
};

export type AgentSession = {
  id: string;
  title: string;
  agent: AgentId;
  model: string | null;
  /** 当前会话选中的 runner id。 */
  runnerId: string | null;
  status: AgentStatus;
  createdAt: string;
  updatedAt: string;
  codexThreadId: string | null;
  claudeSessionId: string | null;
  messages: AgentMessage[];
  events: AgentEvent[];
};

export type EnvironmentStatus = {
  id: string;
  name: string;
  installed: boolean;
  installable: boolean;
  busy: boolean;
  detail: string;
  installCommand: string;
  description: string;
};

export type InstallResult = {
  id: string;
  name: string;
  ok: boolean;
  code: number | null;
  output: string;
};

export type AgentModelOption = {
  id: string;
  label: string;
  source: "agent" | "config";
};

export type AgentOption = {
  id: AgentId;
  name: string;
  installed: boolean;
  enabled: boolean;
  installable: boolean;
  busy: boolean;
  runnable: boolean;
  detail: string;
  installCommand: string;
  description: string;
  models: AgentModelOption[];
  defaultModel: string | null;
  modelSource: string;
  supportsFreeformModel: boolean;
};

export type SettingsTab = "providers" | "agents" | "environment";

export type ProviderFormState = {
  id: string;
  label: string;
  format: ProviderFormat;
  baseUrl: string;
  apiKeyEnv: string;
  apiKey: string;
  models: string;
};

export type ProviderTextField = Exclude<keyof ProviderFormState, "format">;
