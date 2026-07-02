import { createId, nowIso } from "../../runtime/id.js";
import type { AgentDriver, AgentEvent, RunTurnInput } from "../../runtime/types.js";

type CodexConstructor = new (options?: Record<string, unknown>) => {
  startThread(options?: Record<string, unknown>): CodexThread;
  resumeThread(id: string, options?: Record<string, unknown>): CodexThread;
};

type CodexThread = {
  id: string | null;
  runStreamed(input: string, options?: { signal?: AbortSignal }): Promise<{
    events: AsyncGenerator<CodexThreadEvent>;
  }>;
};

type CodexThreadEvent = {
  type: string;
  thread_id?: string;
  item?: CodexThreadItem;
  usage?: Record<string, unknown>;
  error?: { message?: string };
  message?: string;
};

type CodexThreadItem = {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number;
  status?: string;
  query?: string;
  changes?: Array<{ path?: string; kind?: string }>;
  items?: Array<{ text?: string; completed?: boolean }>;
  server?: string;
  tool?: string;
  arguments?: unknown;
  message?: string;
  error?: { message?: string };
};

export class CodexAgentDriver implements AgentDriver {
  private readonly threads = new Map<string, CodexThread>();

  async *runTurn(input: RunTurnInput): AsyncGenerator<AgentEvent> {
    let codexClass: CodexConstructor;
    try {
      codexClass = await loadCodexClass();
    } catch (error) {
      const missing = isModuleMissing(error);
      yield this.event(
        input.session.id,
        "error",
        missing ? "Codex SDK 未安装" : "Codex SDK 加载失败",
        missing ? sdkMissingMessage(error) : sdkLoadFailureMessage(error),
        "failed",
      );
      return;
    }

    const codex = new codexClass({
      apiKey: process.env.OPENAI_API_KEY,
      baseUrl: process.env.OPENAI_BASE_URL,
      config: {
        show_raw_agent_reasoning: true,
      },
    });

    const threadOptions = {
      workingDirectory: process.env.AGENTDOCK_WORKSPACE || process.cwd(),
      skipGitRepoCheck: true,
      sandboxMode: process.env.AGENTDOCK_CODEX_SANDBOX_MODE || "workspace-write",
      approvalPolicy: process.env.AGENTDOCK_CODEX_APPROVAL_POLICY || "never",
      model: input.model || process.env.AGENTDOCK_CODEX_MODEL,
      modelReasoningEffort: process.env.AGENTDOCK_CODEX_REASONING_EFFORT || "medium",
      networkAccessEnabled: process.env.AGENTDOCK_CODEX_NETWORK === "1",
    };
    const threadKey = `${input.session.id}:${threadOptions.model ?? "default"}`;

    const thread =
      this.threads.get(threadKey) ??
      (input.session.codexThreadId
        ? codex.resumeThread(input.session.codexThreadId, threadOptions)
        : codex.startThread(threadOptions));
    this.threads.set(threadKey, thread);

    yield this.event(input.session.id, "lifecycle", "Codex turn started", "正在把消息交给 Codex SDK。", "started");

    try {
      const { events } = await thread.runStreamed(input.content, { signal: input.signal });
      for await (const event of events) {
        yield* this.mapCodexEvent(input.session.id, event);
      }
    } catch (error) {
      yield this.event(input.session.id, "error", "Codex turn failed", errorMessage(error), "failed");
    }
  }

  private *mapCodexEvent(sessionId: string, event: CodexThreadEvent): Generator<AgentEvent> {
    if (event.type === "thread.started" && event.thread_id) {
      yield this.event(sessionId, "lifecycle", "Codex thread", event.thread_id, "completed", event.type);
      return;
    }
    if (event.type === "turn.started") {
      yield this.event(sessionId, "lifecycle", "思考中", "Codex 已开始处理当前回合。", "started", event.type);
      return;
    }
    if (event.type === "turn.completed") {
      yield this.event(
        sessionId,
        "usage",
        "Token usage",
        JSON.stringify(event.usage ?? {}, null, 2),
        "completed",
        event.type,
      );
      return;
    }
    if (event.type === "turn.failed") {
      yield this.event(sessionId, "error", "Codex failed", event.error?.message ?? "未知错误", "failed", event.type);
      return;
    }
    if (event.type === "error") {
      yield this.event(sessionId, "error", "Codex stream error", event.message ?? "未知错误", "failed", event.type);
      return;
    }
    if (event.item) {
      yield this.itemToEvent(sessionId, event.type, event.item);
    }
  }

  private itemToEvent(sessionId: string, rawType: string, item: CodexThreadItem): AgentEvent {
    const itemType = item.type ?? "unknown";
    if (itemType === "agent_message") {
      return this.event(sessionId, "message", "Codex", item.text ?? "", statusFromRaw(rawType), rawType);
    }
    if (itemType === "reasoning") {
      return this.event(sessionId, "reasoning", "思考", item.text ?? "", statusFromRaw(rawType), rawType);
    }
    if (itemType === "command_execution") {
      const output = item.aggregated_output ? `\n\n${item.aggregated_output}` : "";
      const exitCode = item.exit_code === undefined ? "" : `\nexit_code=${item.exit_code}`;
      return this.event(sessionId, "tool", "Shell", `${item.command ?? ""}${exitCode}${output}`, statusFromRaw(rawType), rawType);
    }
    if (itemType === "file_change") {
      const changes = (item.changes ?? [])
        .map((change) => `${change.kind ?? "change"} ${change.path ?? ""}`)
        .join("\n");
      return this.event(sessionId, "tool", "File changes", changes, statusFromRaw(rawType), rawType);
    }
    if (itemType === "mcp_tool_call") {
      return this.event(
        sessionId,
        "tool",
        `MCP ${item.server ?? ""}.${item.tool ?? ""}`,
        item.error?.message ?? JSON.stringify(item.arguments ?? {}, null, 2),
        statusFromRaw(rawType),
        rawType,
      );
    }
    if (itemType === "web_search") {
      return this.event(sessionId, "tool", "Web search", item.query ?? "", statusFromRaw(rawType), rawType);
    }
    if (itemType === "todo_list") {
      const body = (item.items ?? [])
        .map((todo) => `${todo.completed ? "[x]" : "[ ]"} ${todo.text ?? ""}`)
        .join("\n");
      return this.event(sessionId, "reasoning", "计划", body, statusFromRaw(rawType), rawType);
    }
    if (itemType === "error") {
      return this.event(
        sessionId,
        "error",
        "Codex item error",
        item.error?.message ?? item.message ?? item.text ?? "",
        "failed",
        rawType,
      );
    }
    return this.event(sessionId, "tool", itemType, JSON.stringify(item, null, 2), statusFromRaw(rawType), rawType);
  }

  private event(
    sessionId: string,
    kind: AgentEvent["kind"],
    title: string,
    body: string,
    status?: AgentEvent["status"],
    rawType?: string,
  ): AgentEvent {
    return {
      id: createId("evt"),
      sessionId,
      kind,
      title,
      body,
      status,
      rawType,
      createdAt: nowIso(),
    };
  }
}

async function loadCodexClass(): Promise<CodexConstructor> {
  const packageName = "@openai/codex-sdk";
  const mod = (await import(packageName)) as { Codex?: CodexConstructor };
  if (!mod.Codex) {
    throw new Error("@openai/codex-sdk 未导出 Codex");
  }
  return mod.Codex;
}

function statusFromRaw(rawType: string): AgentEvent["status"] {
  if (rawType.endsWith(".started")) {
    return "started";
  }
  if (rawType.endsWith(".updated")) {
    return "updated";
  }
  if (rawType.endsWith(".completed")) {
    return "completed";
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sdkMissingMessage(error: unknown): string {
  return [
    "后端已经接入 Codex SDK adapter，但当前 node_modules 里找不到 @openai/codex-sdk。",
    "可以在设置的“环境检测与安装”里点击安装项目依赖，或执行：npm install",
    "",
    errorMessage(error),
  ].join("\n");
}

function sdkLoadFailureMessage(error: unknown): string {
  return ["@openai/codex-sdk 已被解析到，但加载或导出形态不符合预期。", "", errorMessage(error)].join("\n");
}

function isModuleMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as { code?: unknown }).code === "ERR_MODULE_NOT_FOUND";
}
