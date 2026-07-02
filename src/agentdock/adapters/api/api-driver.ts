import type { AgentDriver, AgentEvent, ProviderConfig, RunTurnInput } from "../../runtime/types.js";
import {
  buildChatMessages,
  errorMessage,
  makeEvent,
  readSse,
  safeJsonParse,
  type ChatMessage,
} from "../shared.js";

/**
 * 纯 API 后端 driver，支持三种 wire format：
 * openai-chat / openai-responses / anthropic。
 *
 * 约定：传入的 input.provider.apiKey 已是"解析后的有效密钥"
 * （由 registry 从环境变量或显式配置解析），driver 不再处理环境变量。
 */
export class ApiAgentDriver implements AgentDriver {
  async *runTurn(input: RunTurnInput): AsyncGenerator<AgentEvent> {
    const provider = input.provider;
    const model = input.model;
    if (!provider) {
      yield makeEvent(input, "error", "缺少 provider", "该 API runner 没有解析到 provider 配置。", "failed");
      return;
    }
    if (!model) {
      yield makeEvent(input, "error", "缺少模型", "该 API runner 没有指定模型。", "failed");
      return;
    }
    const apiKey = provider.apiKey?.trim();
    if (!apiKey) {
      yield makeEvent(
        input,
        "error",
        "缺少 API Key",
        `provider "${provider.id}" 未解析到密钥。请在设置里填写 apiKey 或配置 apiKeyEnv 指向的环境变量。`,
        "failed",
      );
      return;
    }

    const label = input.sourceLabel ?? `${provider.label ?? provider.id} · ${model}`;
    yield makeEvent(input, "lifecycle", `${label} 开始`, "正在调用 API。", "started");

    try {
      if (provider.format === "anthropic") {
        yield* this.runAnthropic(input, provider, model, apiKey);
      } else if (provider.format === "openai-responses") {
        yield* this.runOpenAiResponses(input, provider, model, apiKey);
      } else {
        yield* this.runOpenAiChat(input, provider, model, apiKey);
      }
    } catch (error) {
      yield makeEvent(input, "error", "API 调用失败", errorMessage(error), "failed");
    }
  }

  // -- OpenAI Chat Completions（老格式） ------------------------------------
  private async *runOpenAiChat(
    input: RunTurnInput,
    provider: ProviderConfig,
    model: string,
    apiKey: string,
  ): AsyncGenerator<AgentEvent> {
    const url = `${baseOf(provider, "https://api.openai.com/v1")}/chat/completions`;
    const messages = buildChatMessages(input);
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, stream: true, stream_options: { include_usage: true } }),
      signal: input.signal,
    });
    if (!response.ok) {
      yield makeEvent(input, "error", "API 返回错误", await errorBody(response), "failed");
      return;
    }
    let text = "";
    let reasoning = "";
    let usage: unknown = null;
    for await (const data of readSse(response.body)) {
      if (data === "[DONE]") {
        break;
      }
      const json = safeJsonParse<OpenAiChatChunk>(data);
      if (!json) {
        continue;
      }
      if (json.usage) {
        usage = json.usage;
      }
      const delta = json.choices?.[0]?.delta;
      if (delta?.content) {
        text += delta.content;
      }
      if (typeof delta?.reasoning_content === "string") {
        reasoning += delta.reasoning_content;
      }
    }
    yield* this.finish(input, text, reasoning, usage);
  }

  // -- OpenAI Responses（新格式） ------------------------------------------
  private async *runOpenAiResponses(
    input: RunTurnInput,
    provider: ProviderConfig,
    model: string,
    apiKey: string,
  ): AsyncGenerator<AgentEvent> {
    const url = `${baseOf(provider, "https://api.openai.com/v1")}/responses`;
    const messages = buildChatMessages(input);
    const inputItems = messages.map((message) => ({ role: message.role, content: message.content }));
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, input: inputItems, stream: true }),
      signal: input.signal,
    });
    if (!response.ok) {
      yield makeEvent(input, "error", "API 返回错误", await errorBody(response), "failed");
      return;
    }
    let text = "";
    let reasoning = "";
    let usage: unknown = null;
    for await (const data of readSse(response.body)) {
      if (data === "[DONE]") {
        break;
      }
      const json = safeJsonParse<ResponsesEvent>(data);
      if (!json) {
        continue;
      }
      if (json.type === "response.output_text.delta" && typeof json.delta === "string") {
        text += json.delta;
      } else if (json.type === "response.reasoning_summary_text.delta" && typeof json.delta === "string") {
        reasoning += json.delta;
      } else if (json.type === "response.completed") {
        usage = json.response?.usage ?? usage;
        if (!text && typeof json.response?.output_text === "string") {
          text = json.response.output_text;
        }
      } else if (json.type === "error") {
        yield makeEvent(input, "error", "API 流错误", json.message ?? "未知错误", "failed");
      }
    }
    yield* this.finish(input, text, reasoning, usage);
  }

  // -- Anthropic Messages --------------------------------------------------
  private async *runAnthropic(
    input: RunTurnInput,
    provider: ProviderConfig,
    model: string,
    apiKey: string,
  ): AsyncGenerator<AgentEvent> {
    const url = `${baseOf(provider, "https://api.anthropic.com/v1")}/messages`;
    const all = buildChatMessages(input);
    const system = all.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
    const messages = all
      .filter((message) => message.role !== "system")
      .map((message) => ({ role: message.role as "user" | "assistant", content: message.content }));
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 8192,
        stream: true,
        ...(system ? { system } : {}),
        messages,
      }),
      signal: input.signal,
    });
    if (!response.ok) {
      yield makeEvent(input, "error", "API 返回错误", await errorBody(response), "failed");
      return;
    }
    let text = "";
    let reasoning = "";
    let usage: Record<string, unknown> = {};
    for await (const data of readSse(response.body)) {
      const json = safeJsonParse<AnthropicEvent>(data);
      if (!json) {
        continue;
      }
      if (json.type === "content_block_delta") {
        if (json.delta?.type === "text_delta" && typeof json.delta.text === "string") {
          text += json.delta.text;
        } else if (json.delta?.type === "thinking_delta" && typeof json.delta.thinking === "string") {
          reasoning += json.delta.thinking;
        }
      } else if (json.type === "message_start" && json.message?.usage) {
        usage = { ...usage, ...json.message.usage };
      } else if (json.type === "message_delta" && json.usage) {
        usage = { ...usage, ...json.usage };
      } else if (json.type === "error") {
        yield makeEvent(input, "error", "API 流错误", json.error?.message ?? "未知错误", "failed");
      }
    }
    yield* this.finish(input, text, reasoning, usage);
  }

  private async *finish(
    input: RunTurnInput,
    text: string,
    reasoning: string,
    usage: unknown,
  ): AsyncGenerator<AgentEvent> {
    if (reasoning.trim()) {
      yield makeEvent(input, "reasoning", "思考", reasoning, "completed");
    }
    if (text.trim()) {
      yield makeEvent(input, "message", input.sourceLabel ?? "回复", text, "completed");
    } else {
      yield makeEvent(input, "error", "空回复", "API 未返回任何文本。", "failed");
    }
    if (usage && typeof usage === "object") {
      yield makeEvent(input, "usage", "Token usage", JSON.stringify(usage, null, 2), "completed");
    }
  }
}

function baseOf(provider: ProviderConfig, fallback: string): string {
  const base = provider.baseUrl?.trim() || fallback;
  return base.replace(/\/$/, "");
}

async function errorBody(response: Response): Promise<string> {
  const raw = await response.text().catch(() => "");
  return `HTTP ${response.status} ${response.statusText}\n${raw.slice(0, 2000)}`;
}

// -- 各格式最小事件类型 ------------------------------------------------------

type OpenAiChatChunk = {
  choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }>;
  usage?: unknown;
};

type ResponsesEvent = {
  type?: string;
  delta?: string;
  message?: string;
  response?: { usage?: unknown; output_text?: string };
};

type AnthropicEvent = {
  type?: string;
  delta?: { type?: string; text?: string; thinking?: string };
  message?: { usage?: Record<string, unknown> };
  usage?: Record<string, unknown>;
  error?: { message?: string };
};
