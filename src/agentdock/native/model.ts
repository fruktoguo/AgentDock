// L0 模型客户端：把各家 wire 协议归一化成 ResponseEvent 流。
//
// 载重不变量 #1：wire 形状只在这里出现，绝不逃逸到上层。
// 目前先实现 anthropic wire（通过全局 fetch + 复用 readSse）。

import { errorMessage, readSse, safeJsonParse } from "../adapters/shared.js";
import type { ProviderConfig } from "../runtime/types.js";
import type { ContentPart, Message, ResponseEvent, ToolSpec } from "./types.js";

/** stream() 的请求参数。model 为模型 id 字符串。 */
export type ModelStreamRequest = {
  system?: string;
  messages: Message[];
  tools: ToolSpec[];
  model: string;
  signal?: AbortSignal;
};

/** 统一的模型客户端接口。 */
export interface ModelClient {
  stream(req: ModelStreamRequest): AsyncGenerator<ResponseEvent>;
}

/** 构造 ModelClient 所需的依赖（provider 提供 baseUrl / apiKey 等）。 */
export type ModelClientDeps = {
  provider: ProviderConfig;
  /** 可选：覆盖默认的 fetch（测试注入用）。 */
  fetchImpl?: typeof fetch;
};

/** 没有 modelMeta 时的兜底输出上限。 */
const DEFAULT_MAX_TOKENS = 8192;

// ---------------------------------------------------------------------------
// Anthropic wire 侧的最小类型（仅在 L0 内部使用，不外泄）
// ---------------------------------------------------------------------------

/** 发给 Anthropic 的 content block（请求方向）。 */
type AnthropicBlockParam =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

/** 发给 Anthropic 的一条消息。 */
type AnthropicMessageParam = {
  role: "user" | "assistant";
  content: AnthropicBlockParam[];
};

/** Anthropic SSE 事件（响应方向，只挑我们关心的字段）。 */
type AnthropicStreamEvent = {
  type?: string;
  index?: number;
  content_block?: { type?: string; id?: string; name?: string };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  message?: { usage?: unknown };
  usage?: unknown;
  error?: { message?: string };
};

/** 正在拼装中的 tool_use 块状态（按 content block index 索引）。 */
type PendingToolUse = { id: string; name: string; json: string };

/**
 * Anthropic Messages 协议的模型客户端。
 * 基于 ProviderConfig 的 baseUrl / apiKey 构造。
 */
export class AnthropicModelClient implements ModelClient {
  private readonly provider: ProviderConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(deps: ModelClientDeps) {
    this.provider = deps.provider;
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  async *stream(req: ModelStreamRequest): AsyncGenerator<ResponseEvent> {
    const base = (this.provider.baseUrl?.trim() || "https://api.anthropic.com/v1").replace(/\/$/, "");
    const url = `${base}/messages`;
    const apiKey = this.provider.apiKey?.trim() ?? "";

    const body = {
      model: req.model,
      max_tokens: DEFAULT_MAX_TOKENS,
      stream: true,
      ...(req.system ? { system: req.system } : {}),
      messages: toAnthropicMessages(req.messages),
      ...(req.tools.length > 0 ? { tools: toAnthropicTools(req.tools) } : {}),
    };

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (error) {
      // 网络层错误：errorMessage 不含密钥，直接透出。
      yield { kind: "error", message: errorMessage(error) };
      return;
    }

    if (!response.ok) {
      const raw = await response.text().catch(() => "");
      yield {
        kind: "error",
        message: `HTTP ${response.status} ${response.statusText}${raw ? `\n${raw.slice(0, 2000)}` : ""}`,
      };
      return;
    }

    // 逐块拼装 tool_use；text/thinking 直接流式吐 delta。
    const pending = new Map<number, PendingToolUse>();
    let usage: unknown = undefined;
    let stopReason: string | undefined;

    try {
      for await (const data of readSse(response.body)) {
        const event = safeJsonParse<AnthropicStreamEvent>(data);
        if (!event) {
          continue;
        }

        switch (event.type) {
          case "message_start": {
            if (event.message?.usage !== undefined) {
              usage = mergeUsage(usage, event.message.usage);
            }
            break;
          }
          case "content_block_start": {
            // 只有 tool_use 块需要记账；其余（text/thinking）无需状态。
            if (event.content_block?.type === "tool_use" && typeof event.index === "number") {
              pending.set(event.index, {
                id: event.content_block.id ?? "",
                name: event.content_block.name ?? "",
                json: "",
              });
            }
            break;
          }
          case "content_block_delta": {
            const delta = event.delta;
            if (!delta) {
              break;
            }
            if (delta.type === "text_delta" && typeof delta.text === "string") {
              yield { kind: "text_delta", text: delta.text };
            } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
              yield { kind: "thinking_delta", text: delta.thinking };
            } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
              // 累积到对应 tool_use 块（此刻绝不外泄半截 args）。
              if (typeof event.index === "number") {
                const tool = pending.get(event.index);
                if (tool) {
                  tool.json += delta.partial_json;
                }
              }
            }
            break;
          }
          case "content_block_stop": {
            // tool_use 块收尾：解析累积 JSON，发出一个完整的 tool_call。
            if (typeof event.index === "number") {
              const tool = pending.get(event.index);
              if (tool) {
                pending.delete(event.index);
                const args = tool.json.trim() ? (safeJsonParse<unknown>(tool.json) ?? {}) : {};
                yield { kind: "tool_call", call: { id: tool.id, name: tool.name, args } };
              }
            }
            break;
          }
          case "message_delta": {
            if (typeof event.delta?.stop_reason === "string") {
              stopReason = event.delta.stop_reason;
            }
            if (event.usage !== undefined) {
              usage = mergeUsage(usage, event.usage);
            }
            break;
          }
          case "message_stop": {
            yield { kind: "completed", usage, stopReason };
            break;
          }
          case "error": {
            yield { kind: "error", message: event.error?.message ?? "未知的流错误" };
            break;
          }
          default:
            break;
        }
      }
    } catch (error) {
      // 流读取过程中的异常（含 abort）：errorMessage 不含密钥。
      yield { kind: "error", message: errorMessage(error) };
    }
  }
}

/** 把规范消息映射成 Anthropic content blocks。thinking 块不回传。 */
function toAnthropicMessages(messages: Message[]): AnthropicMessageParam[] {
  const result: AnthropicMessageParam[] = [];
  for (const message of messages) {
    // system 走 req.system，历史里只保留 user / assistant。
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }
    const content = toAnthropicBlocks(message.content);
    if (content.length === 0) {
      continue;
    }
    // 防御性合并连续同 role 消息：Anthropic 要求角色严格交替，否则 400。
    const last = result[result.length - 1];
    if (last && last.role === message.role) {
      last.content.push(...content);
    } else {
      result.push({ role: message.role, content });
    }
  }
  return result;
}

function toAnthropicBlocks(parts: ContentPart[]): AnthropicBlockParam[] {
  const blocks: AnthropicBlockParam[] = [];
  for (const part of parts) {
    switch (part.type) {
      case "text":
        blocks.push({ type: "text", text: part.text });
        break;
      case "tool_call":
        blocks.push({ type: "tool_use", id: part.id, name: part.name, input: part.args });
        break;
      case "tool_result":
        blocks.push({
          type: "tool_result",
          tool_use_id: part.callId,
          content: part.output,
          ...(part.isError ? { is_error: true } : {}),
        });
        break;
      case "thinking":
        // 思考块不回传给模型。
        break;
      default:
        break;
    }
  }
  return blocks;
}

/** ToolSpec -> Anthropic tool 声明。 */
function toAnthropicTools(tools: ToolSpec[]): Array<{ name: string; description: string; input_schema: unknown }> {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

/** 合并 usage 片段（message_start 给输入，message_delta 给输出）。 */
function mergeUsage(prev: unknown, next: unknown): unknown {
  if (prev && typeof prev === "object" && next && typeof next === "object") {
    return { ...(prev as Record<string, unknown>), ...(next as Record<string, unknown>) };
  }
  return next ?? prev;
}
