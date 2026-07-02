import { icon } from "../icons.js";
import { runnerLabel } from "../state.js";
import type { AgentEvent, AgentMessage, AgentSession } from "../types.js";
import {
  compareCreatedAt,
  escapeHtml,
  eventIcon,
  formatBody,
  formatUsageSummary,
  isInsideTurn,
} from "../utils.js";
import { isStructuredOrchestrationEvent, renderOrchestrationBoard, PLAN_RAW_TYPE } from "./orchestration.js";

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

  // 1. 编排看板（结构化事件驱动）。空串 = 无计划事件或 JSON 损坏 → 不出看板，走下方回退。
  const board = renderOrchestrationBoard(events);
  const boardRendered = board.length > 0;
  if (boardRendered) {
    out.push(board);
  }

  // 2. 计划卡片：看板已渲染则跳过被其消费的 orchestrator.plan；
  //    损坏的 orchestrator.plan / 旧式 plan 事件继续走 renderPlanCard 的 <pre> 回退。
  for (const event of events.filter((item) => item.kind === "plan")) {
    if (boardRendered && event.rawType === PLAN_RAW_TYPE) {
      continue;
    }
    out.push(renderPlanCard(event));
  }

  // 3. 子任务分组：按 group 归组，结构化事件不入桶（既避免 JSON 噪音，也避免仅有状态事件的空分组）。
  const groupOrder: string[] = [];
  const buckets = new Map<string, AgentEvent[]>();
  for (const event of events) {
    if (event.kind === "plan" || !event.group || isStructuredOrchestrationEvent(event)) {
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
    (event) =>
      event.kind !== "plan" &&
      event.kind !== "dispatch" &&
      !event.group &&
      !isStructuredOrchestrationEvent(event),
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
  // 结构化 orchestrator.step 事件已在归组时排除；此处 events 均为人读 dispatch + 子任务底层事件。
  // 优先用子任务事件的 source（执行体展示名），退回派发事件 source。
  const dispatch = events.find((event) => event.kind === "dispatch");
  const source =
    events.find((event) => event.source && event.kind !== "dispatch")?.source ||
    dispatch?.source ||
    events.find((event) => event.source)?.source ||
    groupId;
  const body = events; // 人读 dispatch（含 instruction 全文）与子任务底层事件照旧进 details
  const failed = events.some((event) => event.kind === "error" || event.status === "failed");
  const completed = events.some((event) => event.status === "completed" || event.rawType === "turn.completed");
  const status = failed ? "失败" : completed ? "完成" : "处理中";
  const usage = formatUsageSummary(events);
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
  const usage = formatUsageSummary(events);
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

