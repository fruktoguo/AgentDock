// L2 · MCP：McpManager —— 把若干 MCP server 作为「工具提供方」归一化进 ToolRegistry。
//
// 职责：启动各 server、tools/list、把每个 MCP 工具映射成一个 native Tool
//（name 命名空间化为 mcp__<server>__<tool>，parameters 取 inputSchema，
// execute -> tools/call -> {output,isError}），并支持统一 stop 与错误隔离。
//
// 错误隔离：某个 server 启动失败/调用失败，只影响它自己的工具，绝不拖垮其它 server 或 agent。
// 所有工具执行失败均以结构化 { output, isError:true } 回传，绝不 throw 到 loop 外。

import { createTool, type Tool, type ToolRegistry } from "../tool.js";
import type { ToolContext, ToolResultData } from "../tool.js";
import type { JsonSchema } from "../types.js";
import { McpClient, type McpCallResult, type McpServerSpec, type McpToolDef } from "./client.js";

/** McpManager 可调参数。 */
export interface McpManagerOptions {
  /** 透传给每个 McpClient 的单次请求超时（毫秒）。 */
  requestTimeoutMs?: number;
}

/** 单个受管 server 的诊断状态。 */
export interface McpServerStatus {
  name: string;
  running: boolean;
  pid?: number;
  /** 该 server 暴露的（归一化后）工具名清单。 */
  toolNames: string[];
  /** 启动失败原因（成功则 undefined）。 */
  error?: string;
}

/** MCP 工具输出上限（字符），超出尾部截断，避免单次返回把上下文打爆。 */
const MCP_OUTPUT_CAP = 100_000;

/** 内部受管条目。 */
interface ManagedServer {
  spec: McpServerSpec;
  client: McpClient;
  tools: McpToolDef[];
  error?: string;
}

/**
 * MCP 管理器：批量启动 server、把其工具归一化注册进 ToolRegistry、统一关闭。
 * 生命周期：start() -> registerInto(registry) -> ...（agent 运行）... -> stop()。
 */
export class McpManager {
  private readonly servers: ManagedServer[] = [];

  constructor(
    private readonly specs: McpServerSpec[],
    private readonly opts: McpManagerOptions = {},
  ) {}

  /**
   * 并发启动全部 server 并各自 tools/list。错误隔离：单个 server 失败只记录 error，
   * 不影响其它 server；本方法自身不 throw。
   */
  async start(): Promise<void> {
    this.servers.length = 0;
    await Promise.all(this.specs.map((spec) => this.startOne(spec)));
  }

  private async startOne(spec: McpServerSpec): Promise<void> {
    const client = new McpClient(spec, { requestTimeoutMs: this.opts.requestTimeoutMs });
    const managed: ManagedServer = { spec, client, tools: [] };
    this.servers.push(managed);
    try {
      await client.start();
      managed.tools = await client.listTools();
    } catch (err) {
      managed.error = errText(err);
      // 启动/列举失败：尽力清理子进程，避免留下僵尸。
      try {
        await client.stop();
      } catch {
        /* 忽略 */
      }
    }
  }

  /** 把所有已成功启动的 server 的工具归一化后注册进 registry。 */
  registerInto(registry: ToolRegistry): void {
    for (const managed of this.servers) {
      if (managed.error) {
        continue;
      }
      for (const def of managed.tools) {
        registry.register(this.toNativeTool(managed, def));
      }
    }
  }

  /** 各 server 诊断状态。 */
  status(): McpServerStatus[] {
    return this.servers.map((m) => ({
      name: m.spec.name,
      running: m.client.isRunning(),
      pid: m.client.pid,
      toolNames: m.tools.map((t) => mcpToolName(m.spec.name, t.name)),
      error: m.error,
    }));
  }

  /** 已归一化的全部工具名（供诊断/日志）。 */
  toolNames(): string[] {
    const names: string[] = [];
    for (const m of this.servers) {
      if (m.error) {
        continue;
      }
      for (const t of m.tools) {
        names.push(mcpToolName(m.spec.name, t.name));
      }
    }
    return names;
  }

  /** 关闭全部 server（幂等，绝不 throw）。 */
  async stop(): Promise<void> {
    await Promise.all(
      this.servers.map((m) =>
        m.client.stop().catch(() => {
          /* 忽略：stop 已尽力 */
        }),
      ),
    );
  }

  /** 把一个 MCP 工具定义包成 native Tool。 */
  private toNativeTool(managed: ManagedServer, def: McpToolDef): Tool {
    const toolName = mcpToolName(managed.spec.name, def.name);
    const parameters = normalizeSchema(def.inputSchema);
    const client = managed.client;
    // 捕获原始 MCP 工具名（tools/call 用它，而非命名空间化后的 toolName）。
    const rawName = def.name;
    return createTool({
      name: toolName,
      description:
        def.description ||
        `MCP 工具 ${rawName}（来自 server ${managed.spec.name}）。`,
      parameters,
      async execute(args: unknown, ctx: ToolContext): Promise<ToolResultData> {
        if (ctx.signal?.aborted) {
          return { output: "调用在启动前已被中止", isError: true };
        }
        try {
          const res: McpCallResult = await client.callTool(rawName, args ?? {});
          return { output: capOutput(res.output), isError: res.isError };
        } catch (err) {
          // 错误隔离：MCP 调用失败以结构化错误回传，绝不 throw 到 loop 外。
          return { output: `MCP 工具 ${toolName} 调用失败：${errText(err)}`, isError: true };
        }
      },
    });
  }
}

/**
 * 工具命名空间化：mcp__<server>__<tool>。
 * 对 server/tool 名做清洗（只保留 [A-Za-z0-9_-]，其余替换为 _），使最终名满足
 * 主流模型对工具名的字符/长度约束；真正的 tools/call 仍用原始工具名（见 toNativeTool）。
 */
export function mcpToolName(server: string, tool: string): string {
  const name = `mcp__${sanitize(server)}__${sanitize(tool)}`;
  return name.length > 64 ? name.slice(0, 64) : name;
}

/** 只保留工具名允许的字符。 */
function sanitize(s: string): string {
  const cleaned = s.replace(/[^A-Za-z0-9_-]/g, "_");
  return cleaned.length > 0 ? cleaned : "_";
}

/**
 * 归一化工具入参 schema：createTool 要求 parameters.type === "object"。
 * MCP 工具可能省略 type 或给出非 object 顶层 schema，这里统一补/纠成 object schema，
 * 保留其余字段（properties/required 等）。
 */
function normalizeSchema(schema: JsonSchema | undefined): JsonSchema {
  if (schema && typeof schema === "object") {
    if ((schema as { type?: unknown }).type === "object") {
      return schema;
    }
    // 有 schema 但 type 非 object：强制 type=object，保留其余键。
    return { ...schema, type: "object" };
  }
  // 完全缺省：给一个宽松的空对象 schema。
  return { type: "object", properties: {}, additionalProperties: true };
}

/** 有界截断工具输出。 */
function capOutput(text: string): string {
  if (text.length <= MCP_OUTPUT_CAP) {
    return text;
  }
  return `${text.slice(0, MCP_OUTPUT_CAP)}\n…（MCP 输出已截断，原文共 ${text.length} 字符）`;
}

/** 归一化错误文本（MCP 无密钥，直接取 message）。 */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 从环境解析 MCP server 规格（供 driver 零配置接线用）。
 * 优先级：AGENTDOCK_MCP_SERVERS（内联 JSON 数组）> AGENTDOCK_MCP_CONFIG_JSON（同义，别名）。
 * 未配置或解析失败一律返回 []（保证「无配置 = 零影响」，绝不 throw）。
 *
 * 期望形状：[{ "name": "...", "command": "...", "args"?: [...], "env"?: {...}, "cwd"?: "..." }, ...]
 */
export function resolveMcpSpecs(
  env: Record<string, string | undefined> = process.env,
): McpServerSpec[] {
  const raw = env["AGENTDOCK_MCP_SERVERS"] ?? env["AGENTDOCK_MCP_CONFIG_JSON"];
  if (!raw || raw.trim().length === 0) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return []; // 配置非法：退化为无 MCP，绝不影响宿主。
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const specs: McpServerSpec[] = [];
  for (const item of parsed) {
    const spec = toSpec(item);
    if (spec) {
      specs.push(spec);
    }
  }
  return specs;
}

/** 校验并归一化单条 server 规格；不合法返回 undefined。 */
function toSpec(item: unknown): McpServerSpec | undefined {
  if (typeof item !== "object" || item === null) {
    return undefined;
  }
  const o = item as Record<string, unknown>;
  const name = o["name"];
  const command = o["command"];
  if (typeof name !== "string" || name.length === 0) {
    return undefined;
  }
  if (typeof command !== "string" || command.length === 0) {
    return undefined;
  }
  const spec: McpServerSpec = { name, command };
  if (Array.isArray(o["args"])) {
    spec.args = o["args"].filter((a): a is string => typeof a === "string");
  }
  const env = o["env"];
  if (typeof env === "object" && env !== null && !Array.isArray(env)) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
      if (typeof v === "string") {
        out[k] = v;
      }
    }
    spec.env = out;
  }
  if (typeof o["cwd"] === "string" && o["cwd"].length > 0) {
    spec.cwd = o["cwd"];
  }
  return spec;
}
