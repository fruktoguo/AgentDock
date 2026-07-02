import { state } from "../state.js";
import type { AgentOption } from "../types.js";
import { escapeHtml } from "../utils.js";
import { renderInstallResults } from "./environment.js";

/** 本机 Agent 设置页：展示安装状态、启用开关和默认模型。 */
export function renderAgentSettings(): string {
  return `
    <div class="section-head">
      <div>
        <h2>本机 Agent</h2>
        <p>检测、安装并启用本机 CLI Agent（Codex / Claude Code 可作为 runner）。</p>
      </div>
      <div class="section-actions">
        <button data-action="refresh-agents" class="secondary-btn" ${state.agentBusy ? "disabled" : ""}>
          ${state.agentBusy ? "检测中…" : "重新检测"}
        </button>
        <button data-action="install-agent" data-install-agent="missing" class="primary-btn" ${state.agentBusy ? "disabled" : ""}>
          ${state.agentBusy ? "安装中…" : "安装缺失 Agent"}
        </button>
      </div>
    </div>
    <div class="data-list">
      ${
        state.agentOptions.length === 0 && state.agentBusy
          ? `<div class="empty-block">正在检测 Agent…</div>`
          : state.agentOptions.length === 0
            ? `<div class="empty-block">点击重新检测获取当前 Agent 状态。</div>`
            : state.agentOptions.map((item) => renderAgentItem(item)).join("")
      }
    </div>
    ${state.agentInstallResults.length > 0 ? renderInstallResults(state.agentInstallResults) : ""}
  `;
}

function renderAgentItem(item: AgentOption): string {
  const canEnable = item.installed && item.runnable;
  const canPickModel = item.installed && item.models.length > 0;
  const modelOptions = item.models.length
    ? item.models
        .map(
          (model) => `
            <option value="${escapeHtml(model.id)}" ${model.id === item.defaultModel ? "selected" : ""}>
              ${escapeHtml(model.label)}${model.label === model.id ? "" : ` · ${escapeHtml(model.id)}`}
            </option>
          `,
        )
        .join("")
    : `<option value="">未检测到模型</option>`;
  return `
    <article class="agent-row">
      <div class="agent-name">
        <strong>${escapeHtml(item.name)}</strong>
        <small>${escapeHtml(item.modelSource)}</small>
      </div>
      <select
        class="agent-model-select"
        data-agent-model="${escapeHtml(item.id)}"
        ${state.agentBusy || !canPickModel ? "disabled" : ""}
      >
        ${modelOptions}
      </select>
      <div class="agent-checks">
        <span class="check-field">
          <span class="status-pill ${item.installed ? "ok" : "muted"}">${item.installed ? "已安装" : "未安装"}</span>
        </span>
        <label class="switch" title="${escapeHtml(item.runnable ? "启用后会出现在输入框 Runner 选择中" : "后端 adapter 未接入，暂不能启用")}">
          <input
            type="checkbox"
            data-enable-agent="${escapeHtml(item.id)}"
            ${item.enabled ? "checked" : ""}
            ${state.agentBusy || !canEnable ? "disabled" : ""}
          />
          <span class="switch-track"></span>
          <span>启用</span>
        </label>
        <button
          class="secondary-btn"
          data-action="install-agent"
          data-install-agent="${escapeHtml(item.id)}"
          ${state.agentBusy || item.busy ? "disabled" : ""}
        >
          ${item.installed ? "重新安装" : "安装"}
        </button>
      </div>
    </article>
  `;
}
