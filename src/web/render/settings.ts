import { icon } from "../icons.js";
import { state } from "../state.js";
import type { SettingsTab } from "../types.js";
import { escapeHtml } from "../utils.js";
import { renderAgentSettings } from "./agent.js";
import { renderEnvironmentSettings } from "./environment.js";
import { renderProviderSettings } from "./provider.js";

/** 设置页只负责布局和 tab 切换，具体内容委托给各领域渲染模块。 */
export function renderSettingsPage(): string {
  const navItems: { id: SettingsTab; label: string; icon: string }[] = [
    { id: "providers", label: "供应商", icon: "cloud" },
    { id: "agents", label: "本机 Agent", icon: "cpu" },
    { id: "environment", label: "环境", icon: "box" },
  ];
  return `
    <section class="settings-page" aria-label="设置">
      <header class="settings-head">
        <div>
          <h2>设置</h2>
          <span>Provider、本机 Agent 与运行环境</span>
        </div>
        <button class="icon-btn" data-action="close-settings" title="关闭">${icon("close")}</button>
      </header>
      <div class="settings-body">
        <nav class="settings-nav">
          <div class="settings-nav-group">实例管理</div>
          ${navItems
            .map(
              (item) => `
                <button class="${state.settingsTab === item.id ? "active" : ""}" data-action="settings-tab" data-settings-tab="${item.id}">
                  ${icon(item.icon)} ${escapeHtml(item.label)}
                </button>
              `,
            )
            .join("")}
        </nav>
        <div class="settings-content">
          ${
            state.settingsTab === "agents"
              ? renderAgentSettings()
              : state.settingsTab === "environment"
                ? renderEnvironmentSettings()
                : renderProviderSettings()
          }
        </div>
      </div>
    </section>
  `;
}
