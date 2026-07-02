// L2 · MCP：单个 MCP server 的极简 stdio JSON-RPC 2.0 客户端。
//
// MCP stdio 传输 = 「按行分隔（\n）的 JSON-RPC 消息」：客户端把请求写进子进程 stdin，
// 服务器把响应写进 stdout；每条消息是一行不含内嵌换行的 JSON；stderr 仅用于日志。
// 本文件只实现 agent 需要的三件事：initialize 握手、tools/list、tools/call。
// HTTP/SSE 传输留待后续。所有网络/进程细节封在本层，绝不上浮到 L1+。
//
// 无新依赖：JSON-RPC 帧/编解码全部手写，只用 node 内置模块。

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
// 复用点：安全 JSON 解析（解析失败返回 null，不 throw）。见架构复用点 #3。
import { safeJsonParse } from "../../adapters/shared.js";
import type { JsonSchema } from "../types.js";

/** 单个 MCP server 的启动规格（stdio 传输）。 */
export interface McpServerSpec {
  /** server 逻辑名（用于工具命名空间 mcp__<name>__<tool>）。 */
  name: string;
  /** 可执行命令（如 "node"、"python"，或某个二进制路径）。 */
  command: string;
  /** 命令参数（可选）。 */
  args?: string[];
  /** 追加的环境变量（会与 process.env 合并；可选）。 */
  env?: Record<string, string>;
  /** 子进程工作目录（可选，缺省继承当前进程 cwd）。 */
  cwd?: string;
}

/** MCP 客户端可调参数。 */
export interface McpClientOptions {
  /** 单次 JSON-RPC 请求超时（毫秒），缺省 30s。 */
  requestTimeoutMs?: number;
}

/** 归一化后的 MCP 工具定义（来自 tools/list）。 */
export interface McpToolDef {
  name: string;
  description: string;
  /** 工具入参 JSON Schema（tools/call 用；可能缺省）。 */
  inputSchema?: JsonSchema;
}

/** 归一化后的 tools/call 结果：内容拍平成文本 + 错误标记。 */
export interface McpCallResult {
  output: string;
  isError: boolean;
}

/** 默认请求超时（毫秒）。 */
const DEFAULT_REQUEST_TIMEOUT = 30_000;
/**
 * tools/list 翻页上限（页）。多数 server 一页即返回全部工具；
 * 此上限仅作防御——异常 server 反复回同一 nextCursor 时避免无限翻页死循环。
 */
const MAX_TOOLS_PAGES = 100;
/** stop() 优雅退出宽限期（毫秒），超时后 SIGKILL 兜底。 */
const STOP_GRACE_MS = 2_000;
/** stderr 诊断缓冲上限（字符），避免异常服务器把内存打爆。 */
const STDERR_CAP = 8_000;
/** 与之协商的 MCP 协议版本。 */
const PROTOCOL_VERSION = "2024-11-05";

/** 在途请求的登记项。 */
interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * 单 server 的 stdio JSON-RPC 客户端。生命周期：start() -> listTools()/callTool() -> stop()。
 * 失败以 Promise reject 暴露（由 McpManager 归一化成结构化工具错误，不 throw 到 loop 外）。
 */
export class McpClient {
  private readonly timeoutMs: number;
  private child?: ChildProcessWithoutNullStreams;
  private rl?: ReadlineInterface;
  /** 自增请求 id。 */
  private nextId = 1;
  /** id -> 在途请求。 */
  private readonly pending = new Map<number, Pending>();
  /** 是否已完成 initialize 握手。 */
  private started = false;
  /** 子进程是否已退出/不可用。 */
  private closed = false;
  /** stderr 诊断环形缓冲（有界）。 */
  private stderrBuf = "";

  constructor(
    private readonly spec: McpServerSpec,
    opts: McpClientOptions = {},
  ) {
    this.timeoutMs =
      typeof opts.requestTimeoutMs === "number" && opts.requestTimeoutMs > 0
        ? opts.requestTimeoutMs
        : DEFAULT_REQUEST_TIMEOUT;
  }

  /** 子进程 pid（用于诊断）。 */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** 是否仍在运行（子进程存活且未 stop）。 */
  isRunning(): boolean {
    return this.child !== undefined && !this.closed;
  }

  /**
   * 启动子进程并完成 initialize 握手（含发出 notifications/initialized）。
   * 幂等：已启动直接返回。命令不存在/握手失败时以 reject 暴露（子进程会被清理）。
   */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    const child = spawn(this.spec.command, this.spec.args ?? [], {
      cwd: this.spec.cwd,
      env: this.spec.env ? { ...process.env, ...this.spec.env } : process.env,
    });
    this.child = child;

    // 子进程级错误（如 ENOENT 找不到命令）：标记关闭并拒绝全部在途请求。
    child.on("error", (err: Error) => {
      this.closed = true;
      this.failAllPending(new Error(`MCP 子进程错误：${err.message}`));
    });
    child.on("close", (code, signal) => {
      this.closed = true;
      this.failAllPending(new Error(`MCP 子进程已退出（code=${String(code)}, signal=${String(signal)}）`));
    });
    // 防御：避免 stdin 写入错误冒泡成未捕获异常（统一交给 error/close 处理）。
    child.stdin.on("error", () => {
      /* 忽略 */
    });
    child.stderr.on("data", (chunk: unknown) => {
      this.appendStderr(String(chunk));
    });

    // 按行读取 stdout，逐条 JSON-RPC 消息分发。
    this.rl = createInterface({ input: child.stdout });
    this.rl.on("line", (line: string) => {
      this.onLine(line);
    });

    // 握手：initialize -> 等结果 -> 发 initialized 通知。
    await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "agentdock", version: "0.1.0" },
    });
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    this.started = true;
  }

  /**
   * 列出该 server 暴露的工具（归一化为 McpToolDef[]）。
   * 按 MCP 约定翻页：response.nextCursor 非空时，带上 params.cursor 继续拉下一页，
   * 累加各页工具直到 nextCursor 缺省/为空——否则首页之后的工具会被静默丢弃。
   */
  async listTools(): Promise<McpToolDef[]> {
    const defs: McpToolDef[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOLS_PAGES; page += 1) {
      // 首页不带 cursor；后续页带上一页返回的 nextCursor（符合 tools/list 约定）。
      const params = cursor === undefined ? {} : { cursor };
      const result = await this.request<{ tools?: unknown; nextCursor?: unknown }>(
        "tools/list",
        params,
      );
      const raw = Array.isArray(result?.tools) ? result.tools : [];
      for (const item of raw) {
        const def = toToolDef(item);
        if (def) {
          defs.push(def);
        }
      }
      // nextCursor 缺省或为空串 => 没有更多页，结束翻页。
      const next = result?.nextCursor;
      if (typeof next !== "string" || next.length === 0) {
        break;
      }
      cursor = next;
    }
    return defs;
  }

  /** 调用一个工具，把返回 content 拍平成文本 + isError。 */
  async callTool(name: string, args: unknown): Promise<McpCallResult> {
    const result = await this.request<unknown>("tools/call", {
      name,
      arguments: args ?? {},
    });
    return normalizeCallResult(result);
  }

  /**
   * 关闭：停读行、拒绝在途请求、优雅结束子进程（关 stdin -> SIGTERM -> 宽限后 SIGKILL）。
   * 幂等，绝不 throw。
   */
  async stop(): Promise<void> {
    const child = this.child;
    this.rl?.close();
    this.rl = undefined;
    this.started = false;
    if (!child) {
      this.closed = true;
      return;
    }
    if (this.closed) {
      // 子进程已自行退出，无需再等。
      this.child = undefined;
      this.failAllPending(new Error("MCP 客户端已关闭"));
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let hardTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (killTimer !== undefined) {
          clearTimeout(killTimer);
        }
        if (hardTimer !== undefined) {
          clearTimeout(hardTimer);
        }
        resolve();
      };
      child.once("close", finish);
      // 先优雅：关 stdin 让服务器读到 EOF 自行退出，再补一发 SIGTERM。
      try {
        child.stdin.end();
      } catch {
        /* 忽略 */
      }
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), STOP_GRACE_MS);
      // 兜底：即便始终收不到 close 也不悬挂。
      hardTimer = setTimeout(finish, STOP_GRACE_MS * 2);
    });
    this.closed = true;
    this.child = undefined;
    this.failAllPending(new Error("MCP 客户端已关闭"));
  }

  /** 最近的 stderr 片段（诊断用）。 */
  stderrTail(): string {
    return this.stderrBuf;
  }

  // ---- 内部 ----

  /** 发一条 JSON-RPC 请求并按 id 等待响应。 */
  private request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (!this.child || this.closed) {
      return Promise.reject(new Error(`MCP server "${this.spec.name}" 未运行，无法发送 ${method}`));
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP 请求超时（${method}，>${this.timeoutMs}ms）`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** 写一条 JSON-RPC 消息（单行 + \n）。 */
  private send(message: Record<string, unknown>): void {
    const child = this.child;
    if (!child || !child.stdin.writable) {
      throw new Error(`MCP server "${this.spec.name}" 的 stdin 不可写`);
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  /** 处理 stdout 的一行：分发响应 / 拒绝服务器请求 / 忽略通知与噪声。 */
  private onLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }
    const msg = safeJsonParse<Record<string, unknown>>(trimmed);
    // 非法帧或非 JSON-RPC 2.0：静默忽略（很多 server 会往 stdout 混打日志）。
    if (!msg || msg["jsonrpc"] !== "2.0") {
      return;
    }
    const id = msg["id"];
    const hasResult = "result" in msg;
    const hasError = "error" in msg;

    // 服务器 -> 客户端 的响应（有 id 且带 result/error）。
    if ((typeof id === "number" || typeof id === "string") && (hasResult || hasError)) {
      const numId = typeof id === "number" ? id : Number(id);
      const pending = this.pending.get(numId);
      if (!pending) {
        return; // 未知或已超时的 id。
      }
      this.pending.delete(numId);
      clearTimeout(pending.timer);
      if (hasError) {
        const errObj = msg["error"];
        pending.reject(new Error(`MCP 错误：${describeRpcError(errObj)}`));
      } else {
        pending.resolve(msg["result"]);
      }
      return;
    }

    // 服务器 -> 客户端 的请求（有 method 且有 id）：极简客户端不实现，回 method not found，
    // 避免服务器无限等待而悬挂。
    if (typeof msg["method"] === "string" && (typeof id === "number" || typeof id === "string")) {
      try {
        this.send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
      } catch {
        /* 忽略 */
      }
      return;
    }
    // 其余（通知等）忽略。
  }

  /** 拒绝并清空全部在途请求。 */
  private failAllPending(err: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }

  /** 有界追加 stderr（保留尾部）。 */
  private appendStderr(chunk: string): void {
    this.stderrBuf = (this.stderrBuf + chunk).slice(-STDERR_CAP);
  }
}

/** 把 tools/list 返回的单个原始条目归一化为 McpToolDef；不合法（无名字）返回 undefined。 */
function toToolDef(item: unknown): McpToolDef | undefined {
  if (!item || typeof item !== "object") {
    return undefined;
  }
  const t = item as { name?: unknown; description?: unknown; inputSchema?: unknown };
  if (typeof t.name !== "string" || t.name.length === 0) {
    return undefined;
  }
  return {
    name: t.name,
    description: typeof t.description === "string" ? t.description : "",
    inputSchema: isPlainObject(t.inputSchema) ? (t.inputSchema as JsonSchema) : undefined,
  };
}

/** 是否为普通对象（非 null、非数组）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 描述 JSON-RPC error 对象（不泄漏冗余结构）。 */
function describeRpcError(err: unknown): string {
  if (isPlainObject(err)) {
    const code = err["code"];
    const message = err["message"];
    const codeStr = typeof code === "number" || typeof code === "string" ? `${code} ` : "";
    return `${codeStr}${typeof message === "string" ? message : "未知错误"}`.trim();
  }
  return "未知错误";
}

/**
 * 把 tools/call 的返回 content 数组拍平成文本 + isError。
 * text 内容取 text 字段；image/resource 等非文本内容以简短占位符表示（不上浮 wire 形状）。
 */
function normalizeCallResult(result: unknown): McpCallResult {
  if (!isPlainObject(result)) {
    return { output: "（MCP 工具无结构化返回）", isError: false };
  }
  const isError = result["isError"] === true;
  const content = result["content"];
  if (!Array.isArray(content)) {
    return {
      output: isError ? "（MCP 工具报告错误，但无内容）" : "（MCP 工具无内容返回）",
      isError,
    };
  }
  const texts: string[] = [];
  for (const part of content) {
    if (!isPlainObject(part)) {
      continue;
    }
    const type = part["type"];
    if (type === "text" && typeof part["text"] === "string") {
      texts.push(part["text"]);
    } else {
      texts.push(`[${typeof type === "string" ? type : "unknown"} 内容]`);
    }
  }
  return { output: texts.join("\n") || "（MCP 工具无文本内容）", isError };
}
