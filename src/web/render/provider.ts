import { icon } from "../icons.js";
import { parseModelsField, state } from "../state.js";
import type { ProviderFormat, SanitizedProvider } from "../types.js";
import { escapeHtml } from "../utils.js";

/** Provider 设置页渲染：卡片列表、表单和模型候选区。 */
export function renderProviderSettings(): string {
  const modelCount = state.providers.reduce((total, provider) => total + provider.models.length, 0);
  const withKey = state.providers.filter((provider) => provider.hasKey).length;
  const showForm = state.editingProviderId !== null || state.providerFormOpen;
  return `
    <div class="section-head">
      <div>
        <h2>AI 供应商</h2>
        <p>配置支持 Anthropic、OpenAI Responses 或 Chat Completions 协议的 API 端点。</p>
      </div>
      <div class="section-actions">
        <button data-action="refresh-providers" class="secondary-btn" ${state.providerBusy ? "disabled" : ""}>
          ${state.providerBusy ? "加载中…" : "刷新"}
        </button>
        <button data-action="new-provider" class="primary-btn" ${state.providerBusy ? "disabled" : ""}>${icon("plus")} 添加供应商</button>
      </div>
    </div>
    <div class="stat-strip">
      <div class="stat"><span class="stat-label">供应商总数</span><span class="stat-value">${state.providers.length}</span></div>
      <div class="stat"><span class="stat-label">已配置密钥</span><span class="stat-value">${withKey}</span></div>
      <div class="stat"><span class="stat-label">可用模型</span><span class="stat-value">${modelCount}</span></div>
    </div>
    ${
      state.providers.length === 0
        ? `<div class="empty-block">还没有配置供应商，点击"添加供应商"接入一个 API 后端。</div>`
        : `<div class="provider-grid">${state.providers.map((item) => renderProviderCard(item)).join("")}</div>`
    }
    ${showForm ? renderProviderForm() : ""}
  `;
}

function formatBadgeLabel(format: ProviderFormat): string {
  if (format === "anthropic") {
    return "ANTHROPIC";
  }
  if (format === "openai-responses") {
    return "RESPONSES";
  }
  return "CHAT";
}

function renderProviderCard(provider: SanitizedProvider): string {
  const shown = provider.models.slice(0, 3);
  const rest = provider.models.length - shown.length;
  const models = shown.length
    ? shown.map((model) => `<span class="model-chip">${escapeHtml(model)}</span>`).join("") +
      (rest > 0 ? `<span class="model-chip more">+${rest}</span>` : "")
    : `<span class="model-chip muted">未配置模型</span>`;
  return `
    <article class="provider-card">
      <div class="provider-card-head">
        <strong>${escapeHtml(provider.label || provider.id)}</strong>
        <span class="format-badge">${formatBadgeLabel(provider.format)}</span>
      </div>
      <div class="provider-card-meta">
        <code>${escapeHtml(provider.id)}</code>
        ${provider.baseUrl ? `<span>${escapeHtml(provider.baseUrl)}</span>` : ""}
        ${provider.apiKeyEnv ? `<span>env: ${escapeHtml(provider.apiKeyEnv)}</span>` : ""}
      </div>
      <div class="provider-models">${models}</div>
      <div class="provider-card-foot">
        <span class="status-pill ${provider.hasKey ? "ok" : "muted"}">${provider.hasKey ? "已配置密钥" : "无密钥"}</span>
        <div class="provider-card-actions">
          <button class="mini-btn" title="编辑" data-action="edit-provider" data-edit-provider="${escapeHtml(provider.id)}" ${state.providerBusy ? "disabled" : ""}>${icon("edit")}</button>
          <button class="mini-btn danger" title="删除" data-action="delete-provider" data-delete-provider="${escapeHtml(provider.id)}" ${state.providerBusy ? "disabled" : ""}>${icon("trash")}</button>
        </div>
      </div>
    </article>
  `;
}

function renderProviderForm(): string {
  const formats: { value: ProviderFormat; label: string }[] = [
    { value: "anthropic", label: "Anthropic" },
    { value: "openai-responses", label: "OpenAI Responses" },
    { value: "openai-chat", label: "OpenAI Chat" },
  ];
  const title = state.editingProviderId ? `编辑 ${state.editingProviderId}` : "添加供应商";
  return `
    <form class="provider-form" id="provider-form">
      <div class="provider-form-head">
        <strong>${escapeHtml(title)}</strong>
        <button type="button" class="secondary-btn" data-action="cancel-provider">取消</button>
      </div>
      <p class="provider-form-desc">配置供应商的 API 凭据、模型列表与协议格式。</p>
      ${state.providerError ? `<div class="form-error">${escapeHtml(state.providerError)}</div>` : ""}
      <div class="form-grid">
        <label class="field">
          <span>供应商 ID</span>
          <input id="pf-id" value="${escapeHtml(state.providerForm.id)}" ${state.editingProviderId ? "readonly" : ""} placeholder="openai" />
        </label>
        <label class="field">
          <span>显示名称</span>
          <input id="pf-label" value="${escapeHtml(state.providerForm.label)}" placeholder="可选" />
        </label>
        <label class="field">
          <span>Base URL</span>
          <input id="pf-baseurl" value="${escapeHtml(state.providerForm.baseUrl)}" placeholder="留空用官方默认" />
        </label>
        <label class="field">
          <span>API Key 环境变量</span>
          <input id="pf-keyenv" value="${escapeHtml(state.providerForm.apiKeyEnv)}" placeholder="OPENAI_API_KEY" />
        </label>
        <label class="field">
          <span>API Key</span>
          <input id="pf-key" type="password" value="${escapeHtml(state.providerForm.apiKey)}" placeholder="留空=保持不变" autocomplete="off" />
        </label>
        <div class="field">
          <span>API 协议</span>
          <div class="segmented" id="pf-format">
            ${formats
              .map(
                (format) => `
                  <button type="button" class="${state.providerForm.format === format.value ? "active" : ""}" data-action="provider-format" data-format="${format.value}">
                    ${escapeHtml(format.label)}
                  </button>
                `,
              )
              .join("")}
          </div>
        </div>
      </div>
      <div class="field wide">
        <div class="field-label-row">
          <span>模型（每行或逗号分隔一个）</span>
          <button type="button" class="mini-text-btn" data-action="fetch-models" ${state.providerModelBusy ? "disabled" : ""}>
            ${state.providerModelBusy ? "拉取中…" : "获取模型列表"}
          </button>
        </div>
        <textarea id="pf-models" rows="3" placeholder="claude-opus-4-8&#10;claude-sonnet-5">${escapeHtml(state.providerForm.models)}</textarea>
        ${renderModelCandidates()}
      </div>
      <div class="form-actions">
        <button type="submit" class="primary-btn" id="save-provider" ${state.providerBusy ? "disabled" : ""}>
          ${state.providerBusy ? "保存中…" : "保存"}
        </button>
      </div>
    </form>
  `;
}

function renderModelCandidates(): string {
  if (state.providerModelBusy) {
    return `<div class="model-fetch-status">正在从 API 拉取模型列表…</div>`;
  }
  const parts: string[] = [];
  if (state.providerModelError) {
    parts.push(`<div class="form-error">${escapeHtml(state.providerModelError)}</div>`);
  }
  if (state.providerModelCandidates.length > 0) {
    const selected = new Set(parseModelsField());
    const chips = state.providerModelCandidates
      .map(
        (id) =>
          `<button type="button" class="model-chip selectable ${selected.has(id) ? "active" : ""}" data-action="toggle-model" data-model-chip="${escapeHtml(id)}">${escapeHtml(id)}</button>`,
      )
      .join("");
    parts.push(`
      <div class="model-candidates">
        <div class="model-candidates-head">
          <span>点击加入 / 移除（共 ${state.providerModelCandidates.length} 个）</span>
          <div class="model-candidates-actions">
            <button type="button" class="mini-text-btn" data-action="models-all">全选</button>
            <button type="button" class="mini-text-btn" data-action="models-clear">清空</button>
          </div>
        </div>
        <div class="model-chip-row">${chips}</div>
      </div>
    `);
  }
  return parts.join("");
}
