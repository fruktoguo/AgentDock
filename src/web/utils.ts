import type { AgentEventKind, AgentStatus } from "./types.js";
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
