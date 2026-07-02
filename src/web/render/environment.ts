import { state } from "../state.js";
import type { EnvironmentStatus, InstallResult } from "../types.js";
import { escapeHtml } from "../utils.js";

/** 基础环境设置页：Node/npm/项目依赖检测和安装结果。 */
export function renderEnvironmentSettings(): string {
  return `
    <div class="section-head">
      <div>
        <h2>环境</h2>
        <p>检测并安装 Node.js、npm 与项目依赖等基础运行环境。</p>
      </div>
      <div class="section-actions">
        <button data-action="refresh-environment" class="secondary-btn" ${state.environmentBusy ? "disabled" : ""}>
          ${state.environmentBusy ? "检测中…" : "重新检测"}
        </button>
        <button data-action="install-environment" data-install-target="missing" class="primary-btn" ${state.environmentBusy ? "disabled" : ""}>
          ${state.environmentBusy ? "安装中…" : "安装缺失项"}
        </button>
      </div>
    </div>
    <div class="data-list">
      ${
        state.environmentItems.length === 0 && state.environmentBusy
          ? `<div class="empty-block">正在检测环境…</div>`
          : state.environmentItems.length === 0
            ? `<div class="empty-block">点击重新检测获取当前环境状态。</div>`
            : state.environmentItems.map((item) => renderEnvironmentItem(item)).join("")
      }
    </div>
    ${state.installResults.length > 0 ? renderInstallResults(state.installResults) : ""}
  `;
}

function renderEnvironmentItem(item: EnvironmentStatus): string {
  return `
    <article class="environment-item">
      <div class="environment-main">
        <div class="environment-title">
          <span class="status-pill ${item.installed ? "ok" : "missing"}">${item.installed ? "已安装" : "未安装"}</span>
          <strong>${escapeHtml(item.name)}</strong>
        </div>
        <p>${escapeHtml(item.description)}</p>
        <code>${escapeHtml(item.installCommand)}</code>
        <small>${escapeHtml(item.detail)}</small>
      </div>
      <button
        class="secondary-btn"
        data-action="install-environment"
        data-install-target="${escapeHtml(item.id)}"
        ${state.environmentBusy || item.busy ? "disabled" : ""}
      >
        ${item.installed ? "重新安装" : "安装"}
      </button>
    </article>
  `;
}

export function renderInstallResults(results: InstallResult[]): string {
  return `
    <div class="install-results">
      <h3>安装结果</h3>
      ${results
        .map(
          (result) => `
            <article class="install-result ${result.ok ? "ok" : "failed"}">
              <div>
                <strong>${escapeHtml(result.name)}</strong>
                <span>${result.ok ? "完成" : `失败${result.code === null ? "" : `(${result.code})`}`}</span>
              </div>
              <pre>${escapeHtml(result.output)}</pre>
            </article>
          `,
        )
        .join("")}
    </div>
  `;
}
