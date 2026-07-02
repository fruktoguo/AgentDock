export type AgentRole = "user" | "assistant" | "system";
export type AgentId = "codex" | "claude" | "opencode" | "hermes" | "qwen" | "kimi" | "goose";

export type AgentMessage = {
  id: string;
  role: AgentRole;
  content: string;
  createdAt: string;
};

export type AgentStatus = "idle" | "running" | "failed";

export type AgentSession = {
  id: string;
  title: string;
  agent: AgentId;
  model: string | null;
  /** 当前会话选中的 runner id（编排 / CLI / API），为空时回退到 agent。 */
  runnerId: string | null;
  status: AgentStatus;
  createdAt: string;
  updatedAt: string;
  /** Codex SDK 线程 id，用于续接对话。 */
  codexThreadId: string | null;
  /** Claude Code CLI 会话 id，用于 --resume 续接。 */
  claudeSessionId: string | null;
  messages: AgentMessage[];
  events: AgentEvent[];
};

export type AgentEventKind =
  | "message"
  | "reasoning"
  | "tool"
  | "lifecycle"
  | "usage"
  | "error"
  | "plan"
  | "dispatch";

export type AgentEvent = {
  id: string;
  sessionId: string;
  kind: AgentEventKind;
  title: string;
  body: string;
  status?: "started" | "updated" | "completed" | "failed";
  rawType?: string;
  /** 产出该事件的 runner 展示名（如 "Claude Code" / "编排 Agent"）。 */
  source?: string;
  /** 编排模式下所属子任务 id，用于分组可视化。 */
  group?: string;
  createdAt: string;
};

// ---------------------------------------------------------------------------
// Provider / Runner 抽象
// ---------------------------------------------------------------------------

export type Backend = "orchestrator" | "cli" | "api";

/** 只支持这三种 wire format，基本覆盖所有主流模型。 */
export type ProviderFormat = "openai-chat" | "openai-responses" | "anthropic";

export type ProviderConfig = {
  id: string;
  label?: string;
  format: ProviderFormat;
  /** 自定义 / 兼容端点；不填用官方默认。 */
  baseUrl?: string;
  /** 优先从该环境变量读取密钥。 */
  apiKeyEnv?: string;
  /** 兜底：显式配置的密钥；对外展示需脱敏。 */
  apiKey?: string;
  models: string[];
};

/** 一个可被选择/派发的执行体。 */
export type RunnerRef =
  | { kind: "orchestrator" }
  | { kind: "cli"; agent: AgentId }
  | { kind: "api"; provider: string; model: string }
  | { kind: "native"; provider: string; model: string };

/** 下拉框里的一个可选项（服务端合并 CLI + API + 编排后下发）。 */
export type RunnerOption = {
  id: string;
  ref: RunnerRef;
  backend: Backend;
  label: string;
  /** 分组：编排 / 本机 CLI / API。 */
  group: string;
  /** 给编排 LLM 的能力提示，纯参考。 */
  capabilityHint?: string;
  available: boolean;
  detail?: string;
};

export type RunTurnInput = {
  session: AgentSession;
  content: string;
  runner: RunnerRef;
  /** api runner 已解析出的 provider 配置。 */
  provider?: ProviderConfig;
  /** 生效模型（api runner 必填，cli 可选）。 */
  model?: string;
  signal?: AbortSignal;
  /** 编排模式下的子任务分组 id。 */
  group?: string;
  /** 事件展示名覆盖（编排派发时标注是谁在跑）。 */
  sourceLabel?: string;
  /** 子 agent 委派深度（根 turn 缺省=0）；native driver 透传给 task 工具做递归封顶。 */
  depth?: number;
};

export type AgentDriver = {
  runTurn(input: RunTurnInput): AsyncGenerator<AgentEvent>;
};

// ---------------------------------------------------------------------------
// Runner id 编解码：dropdown value / plan 里传输用
// ---------------------------------------------------------------------------

const API_SEP = "::";

export function encodeRunner(ref: RunnerRef): string {
  if (ref.kind === "orchestrator") {
    return "orchestrator";
  }
  if (ref.kind === "cli") {
    return `cli:${ref.agent}`;
  }
  if (ref.kind === "native") {
    return `native:${ref.provider}${API_SEP}${ref.model}`;
  }
  return `api:${ref.provider}${API_SEP}${ref.model}`;
}

export function decodeRunner(id: string | null | undefined): RunnerRef | null {
  if (!id) {
    return null;
  }
  if (id === "orchestrator") {
    return { kind: "orchestrator" };
  }
  if (id.startsWith("cli:")) {
    const agent = id.slice(4) as AgentId;
    return agent ? { kind: "cli", agent } : null;
  }
  if (id.startsWith("native:")) {
    const rest = id.slice(7);
    const sep = rest.indexOf(API_SEP);
    if (sep < 0) {
      return null;
    }
    const provider = rest.slice(0, sep);
    const model = rest.slice(sep + API_SEP.length);
    return provider && model ? { kind: "native", provider, model } : null;
  }
  if (id.startsWith("api:")) {
    const rest = id.slice(4);
    const sep = rest.indexOf(API_SEP);
    if (sep < 0) {
      return null;
    }
    const provider = rest.slice(0, sep);
    const model = rest.slice(sep + API_SEP.length);
    return provider && model ? { kind: "api", provider, model } : null;
  }
  return null;
}
