import { icon } from "../icons.js";
import { runnerLabel } from "../state.js";
import type { AgentEvent, AgentMessage, AgentSession } from "../types.js";
import { compareCreatedAt, escapeHtml, eventIcon, formatBody, isInsideTurn } from "../utils.js";

/** 会话时间线渲染：把消息气泡和底层 Agent 事件按用户 turn 归组。 */
export function renderTimeline(session: AgentSession): string {
  const assistantName = runnerLabel();
  if (session.messages.length === 0 && session.events.length === 0) {
    return `
      <div class="empty">
        <div class="empty-mark">${icon("sparkles")}</div>
        <h2>选择一个 Runner，把任务交给它</h2>
        <p>这里会显示对话、规划、派发、工具调用、文件修改和 token 用量。</p>
      </div>
    `;
  }
  const rows: string[] = [];
  const messages = [...session.messages].sort(compareCreatedAt);
  const events = [...session.events]
    .filter((event) => !(event.kind === "message" && event.status === "completed"))
    .sort(compareCreatedAt);
  const userMessages = messages.filter((message) => message.role === "user");

  if (userMessages.length === 0) {
    for (const message of messages) {
      rows.push(renderMessage(message, assistantName));
    }
    rows.push(renderProcessSection(events, assistantName));
    return rows.join("");
  }

  for (let index = 0; index < userMessages.length; index += 1) {
    const userMessage = userMessages[index]!;
    const nextUserMessage = userMessages[index + 1];
    const turnStart = Date.parse(userMessage.createdAt);
    const turnEnd = nextUserMessage ? Date.parse(nextUserMessage.createdAt) : Number.POSITIVE_INFINITY;
    const turnEvents = events.filter((event) => isInsideTurn(event.createdAt, turnStart, turnEnd));
    const assistantMessages = messages.filter(
      (message) => message.role === "assistant" && isInsideTurn(message.createdAt, turnStart, turnEnd),
    );

    rows.push(renderMessage(userMessage, assistantName));
    rows.push(renderProcessSection(turnEvents, assistantName));
    for (const assistantMessage of assistantMessages) {
      rows.push(renderMessage(assistantMessage, assistantName));
    }
  }

  return rows.join("");
}

function renderMessage(message: AgentMessage, assistantName: string): string {
  const name = message.role === "user" ? "你" : assistantName;
  const avatar = message.role === "user" ? "Y" : (assistantName.slice(0, 1) || "A").toUpperCase();
  return `
    <article class="message ${message.role}">
      <div class="avatar">${escapeHtml(avatar)}</div>
      <div class="bubble">
        <div class="bubble-head">${escapeHtml(name)}</div>
        <div class="bubble-body">${formatBody(message.content)}</div>
      </div>
    </article>
  `;
}

function renderProcessSection(events: AgentEvent[], fallbackName: string): string {
  if (events.length === 0) {
    return "";
  }
  const out: string[] = [];
  for (const event of events.filter((item) => item.kind === "plan")) {
    out.push(renderPlanCard(event));
  }

  const groupOrder: string[] = [];
  const buckets = new Map<string, AgentEvent[]>();
  for (const event of events) {
    if (event.kind === "plan" || !event.group) {
      continue;
    }
    if (!buckets.has(event.group)) {
      buckets.set(event.group, []);
      groupOrder.push(event.group);
    }
    buckets.get(event.group)!.push(event);
  }
  for (const group of groupOrder) {
    out.push(renderSubtaskGroup(buckets.get(group)!, group));
  }

  const ungrouped = events.filter(
    (event) => event.kind !== "plan" && event.kind !== "dispatch" && !event.group,
  );
  if (ungrouped.length > 0) {
    out.push(renderProcessGroup(ungrouped, fallbackName, `ung:${ungrouped[0]!.id}`));
  }
  return out.join("");
}

function renderPlanCard(event: AgentEvent): string {
  return `
    <div class="plan-card">
      <div class="plan-head">
        ${icon("list")}
        <strong>规划</strong>
        ${event.source ? `<span class="plan-source">${escapeHtml(event.source)}</span>` : ""}
      </div>
      ${event.title ? `<div class="plan-title">${escapeHtml(event.title)}</div>` : ""}
      ${event.body ? `<pre>${escapeHtml(event.body)}</pre>` : ""}
    </div>
  `;
}

function renderSubtaskGroup(events: AgentEvent[], groupId: string): string {
  const dispatch = events.find((event) => event.kind === "dispatch");
  const source = dispatch?.source || events.find((event) => event.source)?.source || groupId;
  const body = events.filter((event) => event.kind !== "dispatch");
  const failed = events.some((event) => event.kind === "error" || event.status === "failed");
  const completed = events.some((event) => event.status === "completed" || event.rawType === "turn.completed");
  const status = failed ? "失败" : completed ? "完成" : "处理中";
  const usage = usageSummary(events);
  const summary = [`${body.length} 个事件`, usage].filter(Boolean).join(" · ");
  return `
    <div class="dispatch-sep">${icon("send")} 派发给 <strong>${escapeHtml(source)}</strong></div>
    <details class="process-group subtask ${failed ? "failed" : ""}" data-details-key="sub:${escapeHtml(groupId)}">
      <summary>
        <span class="process-icon">${eventIcon(failed ? "error" : "dispatch")}</span>
        <span class="process-copy">
          <strong>${escapeHtml(source)} · ${status}</strong>
          <small>${escapeHtml(summary)}</small>
        </span>
      </summary>
      <div class="process-details">
        ${body.map((event) => renderProcessEvent(event)).join("")}
      </div>
    </details>
  `;
}

function renderProcessGroup(events: AgentEvent[], fallbackName: string, key: string): string {
  const failed = events.some((event) => event.kind === "error" || event.status === "failed");
  const completed = events.some((event) => event.rawType === "turn.completed" || event.status === "completed");
  const status = failed ? "失败" : completed ? "完成" : "处理中";
  const source = events.find((event) => event.source)?.source || fallbackName;
  const threadId = events.find((event) => event.rawType === "thread.started" || event.rawType === "claude.session")?.body.trim();
  const usage = usageSummary(events);
  const summaryParts = [threadId ? `会话 ${threadId}` : "", usage, `${events.length} 个底层事件`].filter(Boolean);

  return `
    <details class="process-group ${failed ? "failed" : ""}" data-details-key="${escapeHtml(key)}">
      <summary>
        <span class="process-icon">${eventIcon(failed ? "error" : "lifecycle")}</span>
        <span class="process-copy">
          <strong>${escapeHtml(source)} 调用${status}</strong>
          <small>${escapeHtml(summaryParts.join(" · "))}</small>
        </span>
      </summary>
      <div class="process-details">
        ${events.map((event) => renderProcessEvent(event)).join("")}
      </div>
    </details>
  `;
}

function renderProcessEvent(event: AgentEvent): string {
  return `
    <div class="process-event">
      <span>${eventIcon(event.kind)}</span>
      <div>
        <strong>${escapeHtml(event.title)}</strong>
        <small>${escapeHtml(event.status ?? event.rawType ?? "")}</small>
        ${event.body ? `<pre>${escapeHtml(event.body)}</pre>` : ""}
      </div>
    </div>
  `;
}

function usageSummary(events: AgentEvent[]): string {
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
