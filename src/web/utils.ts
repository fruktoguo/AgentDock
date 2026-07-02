import type { AgentEvent, AgentEventKind, AgentStatus } from "./types.js";
import { icon } from "./icons.js";

export function statusLabel(status: AgentStatus): string {
  if (status === "running") {
    return "正在运行";
  }
  if (status === "failed") {
    return "运行失败";
  }
  return "空闲";
}

export function eventIcon(kind: AgentEventKind): string {
  const map: Record<AgentEventKind, string> = {
    message: "message-square",
    reasoning: "brain",
    tool: "terminal",
    lifecycle: "activity",
    usage: "gauge",
    error: "alert",
    plan: "list",
    dispatch: "send",
  };
  return icon(map[kind]);
}

export function formatBody(value: string): string {
  return escapeHtml(value).replace(/\n/g, "<br />");
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function compareCreatedAt(left: { createdAt: string }, right: { createdAt: string }): number {
  return left.createdAt.localeCompare(right.createdAt);
}

export function isInsideTurn(createdAt: string, start: number, end: number): boolean {
  const current = Date.parse(createdAt);
  return current >= start && current < end;
}

/** 从一组事件里提取 token 用量摘要（输入 / 输出）。找不到 usage 事件返回空串。 */
export function formatUsageSummary(events: AgentEvent[]): string {
  const usage = events.find((event) => event.kind === "usage" && event.body.trim());
  if (!usage) {
    return "";
  }
  try {
    const parsed = JSON.parse(usage.body) as { input_tokens?: number; output_tokens?: number };
    const input = parsed.input_tokens === undefined ? "" : `输入 ${parsed.input_tokens}`;
    const output = parsed.output_tokens === undefined ? "" : `输出 ${parsed.output_tokens}`;
    return [input, output].filter(Boolean).join(" / ");
  } catch {
    return "Token 用量已记录";
  }
}
