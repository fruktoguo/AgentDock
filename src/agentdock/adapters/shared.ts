import { createId, nowIso } from "../runtime/id.js";
import type { AgentEvent, RunTurnInput } from "../runtime/types.js";

/** 统一构造 AgentEvent，并从 RunTurnInput 上盖 source/group 用于编排可视化。 */
export function makeEvent(
  input: RunTurnInput,
  kind: AgentEvent["kind"],
  title: string,
  body: string,
  status?: AgentEvent["status"],
  rawType?: string,
): AgentEvent {
  return {
    id: createId("evt"),
    sessionId: input.session.id,
    kind,
    title,
    body,
    status,
    rawType,
    source: input.sourceLabel,
    group: input.group,
    createdAt: nowIso(),
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 逐条读取 SSE（text/event-stream）里的 `data:` 负载。
 * 用 getReader + TextDecoder，兼容 TS 的 DOM ReadableStream 类型。
 */
export async function* readSse(
  body: ReadableStream<Uint8Array> | null,
): AsyncGenerator<string> {
  if (!body) {
    return;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = extractData(chunk);
        if (data !== null) {
          yield data;
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
    const tail = extractData(buffer);
    if (tail !== null) {
      yield tail;
    }
  } finally {
    reader.releaseLock();
  }
}

function extractData(chunk: string): string | null {
  const lines = chunk.split("\n");
  const dataLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.replace(/\r$/, "");
    if (trimmed.startsWith("data:")) {
      dataLines.push(trimmed.slice(5).replace(/^ /, ""));
    }
  }
  if (dataLines.length === 0) {
    return null;
  }
  return dataLines.join("\n");
}

/** 逐行读取 NDJSON（stream-json）流。 */
export async function* readLines(
  body: ReadableStream<Uint8Array> | null,
): AsyncGenerator<string> {
  if (!body) {
    return;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line.trim()) {
          yield line;
        }
        newline = buffer.indexOf("\n");
      }
    }
    if (buffer.trim()) {
      yield buffer.trim();
    }
  } finally {
    reader.releaseLock();
  }
}

export function safeJsonParse<T = unknown>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** 把会话历史裁剪成给 API 的多轮消息（简单文本对齐）。 */
export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export function buildChatMessages(input: RunTurnInput, system?: string): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (system) {
    messages.push({ role: "system", content: system });
  }
  for (const message of input.session.messages) {
    if (message.role === "user" || message.role === "assistant") {
      messages.push({ role: message.role, content: message.content });
    }
  }
  // 确保最后一轮是本次用户输入（历史里可能已包含，也可能尚未落库）。
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user" || last.content !== input.content) {
    messages.push({ role: "user", content: input.content });
  }
  return messages;
}
