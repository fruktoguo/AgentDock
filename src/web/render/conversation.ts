import { icon } from "../icons.js";
import { currentRunner, state } from "../state.js";
import type { AgentSession, RunnerOption } from "../types.js";
import { escapeHtml, statusLabel } from "../utils.js";
import { renderTimeline } from "./timeline.js";

/** 对话页渲染：负责顶栏、timeline、状态栏和输入区。 */
export function renderConversationPage(session: AgentSession | null): string {
  const runner = currentRunner();
  const composerDisabled = session?.status === "running" || !runner?.available;
  const placeholder = runner?.available ? "发送消息..." : "没有可用 runner，请到设置里配置 Provider 或安装 CLI";
  return `
    <header class="topbar">
      <div class="thread-title">
        <button class="icon-btn menu-btn" data-action="toggle-sidebar" title="菜单">${icon("menu")}</button>
        <span>对话</span>
      </div>
      <div class="top-actions">
        <span class="thread-meta">${escapeHtml(session?.title ?? "新对话")}</span>
      </div>
    </header>
    <section class="content">
      <div class="timeline">
        ${session ? renderTimeline(session) : ""}
      </div>
    </section>
    <div class="statusbar">${renderStatusbar(session)}</div>
    <footer class="composer">
      <div class="composer-selects">
        ${renderRunnerSelect()}
        ${renderModelControl()}
      </div>
      <textarea id="message-input" rows="1" placeholder="${escapeHtml(placeholder)}" ${composerDisabled ? "disabled" : ""}>${escapeHtml(state.draft)}</textarea>
      <button id="send-message" class="send" data-action="send-message" ${composerDisabled ? "disabled" : ""}>发送</button>
    </footer>
  `;
}

export function renderStatusbar(session: AgentSession | null): string {
  const status = session?.status ?? "idle";
  const items: string[] = [`<span class="statusbar-item"><span class="dot ${status}"></span>${statusLabel(status)}</span>`];
  if (session?.codexThreadId) {
    items.push(`<span class="statusbar-item">线程 ${escapeHtml(session.codexThreadId)}</span>`);
  }
  if (session?.claudeSessionId) {
    items.push(`<span class="statusbar-item">Claude 会话 ${escapeHtml(session.claudeSessionId)}</span>`);
  }
  return items.join(`<span class="statusbar-sep"></span>`);
}

export function renderRunnerSelect(): string {
  const hasAvailable = state.runnerOptions.some((option) => option.available);
  const groups: { name: string; items: RunnerOption[] }[] = [];
  for (const option of state.runnerOptions) {
    let bucket = groups.find((group) => group.name === option.group);
    if (!bucket) {
      bucket = { name: option.group, items: [] };
      groups.push(bucket);
    }
    bucket.items.push(option);
  }
  const body = groups.length
    ? groups
        .map(
          (group) => `
            <optgroup label="${escapeHtml(group.name)}">
              ${group.items
                .map(
                  (option) => `
                    <option value="${escapeHtml(option.id)}" ${option.id === state.selectedRunnerId ? "selected" : ""} ${option.available ? "" : "disabled"}>
                      ${escapeHtml(option.label)}${option.available ? "" : " · 不可用"}
                    </option>
                  `,
                )
                .join("")}
            </optgroup>
          `,
        )
        .join("")
    : `<option value="">无可用 runner</option>`;
  const runner = currentRunner();
  const title = runner?.capabilityHint ? `能力提示：${runner.capabilityHint}` : "选择执行本会话的 runner";
  return `
    <label class="select-wrap runner-wrap" title="${escapeHtml(title)}">
      <span>Runner</span>
      <select id="runner-select" ${hasAvailable ? "" : "disabled"}>${body}</select>
    </label>
  `;
}

export function renderModelControl(): string {
  const runner = currentRunner();
  if (!runner || runner.backend !== "cli" || runner.ref.kind !== "cli") {
    return "";
  }
  const ref = runner.ref;
  const agent = state.agentOptions.find((item) => item.id === ref.agent);
  const models = agent?.models ?? [];
  const listId = "cli-model-list";
  const datalist = models.length
    ? `<datalist id="${listId}">${models
        .map((model) => `<option value="${escapeHtml(model.id)}">${escapeHtml(model.label)}</option>`)
        .join("")}</datalist>`
    : "";
  const placeholder = agent?.defaultModel ? `默认 ${agent.defaultModel}` : "默认模型 / 输入模型 id";
  return `
    <label class="select-wrap" title="仅对 CLI runner 生效，可自由输入模型 id">
      <span>模型</span>
      <input id="cli-model" ${models.length ? `list="${listId}"` : ""} value="${escapeHtml(state.cliModel)}" placeholder="${escapeHtml(placeholder)}" />
      ${datalist}
    </label>
  `;
}

export function sessionListItem(session: AgentSession): string {
  const subtitle = session.codexThreadId ?? session.claudeSessionId ?? session.runnerId ?? "新会话";
  return `
    <button class="conversation ${session.id === state.selectedId ? "active" : ""}" data-action="select-session" data-session-id="${escapeHtml(session.id)}">
      <span class="dot ${session.status}"></span>
      <span class="conversation-text">
        <strong>${escapeHtml(session.title)}</strong>
        <small>${escapeHtml(subtitle)}</small>
      </span>
    </button>
  `;
}
