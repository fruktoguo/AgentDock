import { installAgent, refreshAgentOptions, setAgentDefaultModel, setAgentEnabled, setAgentActionHooks } from "./actions/agents.js";
import { installEnvironment, refreshEnvironment, setEnvironmentActionHooks } from "./actions/environment.js";
import {
  clearModelsField,
  deleteProvider,
  editProvider,
  fetchProviderModelList,
  refreshProviders,
  saveProvider,
  selectAllModels,
  setProviderActionHooks,
  toggleModelInField,
} from "./actions/providers.js";
import { createSession, sendMessage, setSessionActionHooks } from "./actions/sessions.js";
import { PF_FIELD_BY_ID, resetProviderForm, state } from "./state.js";
import type { ProviderFormat, SettingsTab } from "./types.js";

export type RenderHooks = {
  render(): void;
  scheduleIncremental(): void;
  selectSession(id: string | null): void;
  getComposerTextarea(): HTMLTextAreaElement | null;
};

let hooks: RenderHooks;

/**
 * 事件模块通过 hooks 调用顶层渲染/SSE 能力。
 * 这样 DOM 委托逻辑可以独立拆出，又不把 app.ts 的内部引用暴露为全局变量。
 */
export function setRenderHooks(next: RenderHooks): void {
  hooks = next;
  setSessionActionHooks({ render: next.render, selectSession: next.selectSession });
  setEnvironmentActionHooks({ render: next.render });
  setAgentActionHooks({ render: next.render });
  setProviderActionHooks({ render: next.render });
}

/** 所有交互统一走事件委托，避免 workspace 重绘后重复绑定监听器。 */
export function attachDelegatedListeners(appRoot: HTMLElement): void {
  appRoot.addEventListener("click", handleClick);
  appRoot.addEventListener("change", handleChange);
  appRoot.addEventListener("input", handleInput);
  appRoot.addEventListener("submit", handleSubmit);
  appRoot.addEventListener("keydown", handleKeydown);
}

function handleClick(event: Event): void {
  const target = event.target as Element | null;
  const actionEl = target?.closest<HTMLElement>("[data-action]");
  if (!actionEl) {
    return;
  }
  const action = actionEl.dataset.action;
  switch (action) {
    case "toggle-sidebar":
      state.sidebarOpen = !state.sidebarOpen;
      hooks.render();
      break;
    case "close-sidebar":
      state.sidebarOpen = false;
      hooks.render();
      break;
    case "open-conversation":
      state.settingsOpen = false;
      hooks.render();
      break;
    case "toggle-settings":
      state.settingsOpen = !state.settingsOpen;
      state.sidebarOpen = false;
      hooks.render();
      if (state.settingsOpen) {
        void refreshCurrentSettingsTab();
      }
      break;
    case "close-settings":
      state.settingsOpen = false;
      hooks.render();
      break;
    case "settings-tab":
      state.settingsTab = (actionEl.dataset.settingsTab as SettingsTab) ?? "providers";
      hooks.render();
      void refreshCurrentSettingsTab();
      break;
    case "new-session":
      void createSession();
      break;
    case "select-session":
      hooks.selectSession(actionEl.dataset.sessionId ?? null);
      state.settingsOpen = false;
      state.sidebarOpen = false;
      hooks.render();
      break;
    case "send-message":
      void sendMessage(hooks.getComposerTextarea());
      break;
    case "refresh-environment":
      void refreshEnvironment();
      break;
    case "install-environment":
      void installEnvironment(actionEl.dataset.installTarget ?? "");
      break;
    case "refresh-agents":
      void refreshAgentOptions();
      break;
    case "install-agent":
      void installAgent(actionEl.dataset.installAgent ?? "");
      break;
    case "refresh-providers":
      void refreshProviders();
      break;
    case "new-provider":
      resetProviderForm();
      state.providerFormOpen = true;
      hooks.render();
      break;
    case "cancel-provider":
      resetProviderForm();
      hooks.render();
      break;
    case "edit-provider":
      editProvider(actionEl.dataset.editProvider ?? "");
      break;
    case "delete-provider":
      void deleteProvider(actionEl.dataset.deleteProvider ?? "");
      break;
    case "provider-format":
      state.providerForm.format = (actionEl.dataset.format as ProviderFormat) ?? "openai-chat";
      hooks.render();
      break;
    case "fetch-models":
      void fetchProviderModelList();
      break;
    case "models-all":
      selectAllModels();
      break;
    case "models-clear":
      clearModelsField();
      break;
    case "toggle-model":
      toggleModelInField(actionEl.dataset.modelChip ?? "");
      break;
    default:
      break;
  }
}

function handleChange(event: Event): void {
  const target = event.target as HTMLElement | null;
  if (!target) {
    return;
  }
  if (target.id === "runner-select") {
    state.selectedRunnerId = (target as HTMLSelectElement).value;
    state.cliModel = "";
    hooks.render();
    return;
  }
  if (target.dataset.agentModel !== undefined) {
    void setAgentDefaultModel(target.dataset.agentModel, (target as HTMLSelectElement).value);
    return;
  }
  if (target.dataset.enableAgent !== undefined) {
    void setAgentEnabled(target.dataset.enableAgent, (target as HTMLInputElement).checked);
  }
}

function handleInput(event: Event): void {
  const target = event.target as HTMLElement | null;
  if (!target) {
    return;
  }
  if (target.id === "message-input") {
    state.draft = (target as HTMLTextAreaElement).value;
    return;
  }
  if (target.id === "cli-model") {
    state.cliModel = (target as HTMLInputElement).value.trim();
    return;
  }
  const key = PF_FIELD_BY_ID[target.id];
  if (key) {
    state.providerForm[key] = (target as HTMLInputElement | HTMLTextAreaElement).value;
  }
}

function handleSubmit(event: Event): void {
  const target = event.target as HTMLElement | null;
  if (target && target.id === "provider-form") {
    event.preventDefault();
    void saveProvider();
  }
}

function handleKeydown(event: Event): void {
  const keyboardEvent = event as KeyboardEvent;
  const target = event.target as HTMLElement | null;
  if (target && target.id === "message-input" && keyboardEvent.key === "Enter" && !keyboardEvent.shiftKey) {
    keyboardEvent.preventDefault();
    void sendMessage(hooks.getComposerTextarea());
  }
}

async function refreshCurrentSettingsTab(): Promise<void> {
  if (state.settingsTab === "agents") {
    await refreshAgentOptions();
  } else if (state.settingsTab === "environment") {
    await refreshEnvironment();
  } else {
    await refreshProviders();
  }
}
