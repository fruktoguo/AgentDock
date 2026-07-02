import type { AgentSession, AgentOption, EnvironmentStatus, InstallResult, ProviderFormState, ProviderTextField, RunnerOption, SanitizedProvider, SettingsTab } from "./types.js";

export const JSON_HEADERS = { "Content-Type": "application/json" };
export const APP_VERSION = "0.1.0";

/** provider 表单输入框 id → 状态字段（供 input 委托使用）。 */
export const PF_FIELD_BY_ID: Record<string, ProviderTextField> = {
  "pf-id": "id",
  "pf-label": "label",
  "pf-baseurl": "baseUrl",
  "pf-keyenv": "apiKeyEnv",
  "pf-key": "apiKey",
  "pf-models": "models",
};

/**
 * 前端集中状态容器。
 * 原型阶段不引入框架；所有渲染函数只读取这里，所有动作函数只修改这里。
 */
export const state = {
  sessions: [] as AgentSession[],
  selectedId: null as string | null,
  eventSource: null as EventSource | null,
  sidebarOpen: false,
  settingsOpen: false,
  settingsTab: "providers" as SettingsTab,
  environmentItems: [] as EnvironmentStatus[],
  installResults: [] as InstallResult[],
  environmentBusy: false,
  agentOptions: [] as AgentOption[],
  agentInstallResults: [] as InstallResult[],
  agentBusy: false,
  runnerOptions: [] as RunnerOption[],
  selectedRunnerId: null as string | null,
  cliModel: "",
  draft: "",
  providers: [] as SanitizedProvider[],
  providerBusy: false,
  providerError: null as string | null,
  editingProviderId: null as string | null,
  providerFormOpen: false,
  providerForm: blankProviderForm(),
  providerModelBusy: false,
  providerModelError: null as string | null,
  providerModelCandidates: [] as string[],
};

export function blankProviderForm(): ProviderFormState {
  return { id: "", label: "", format: "openai-chat", baseUrl: "", apiKeyEnv: "", apiKey: "", models: "" };
}

export function currentSession(): AgentSession | null {
  return state.sessions.find((item) => item.id === state.selectedId) ?? null;
}

export function upsertSession(session: AgentSession): void {
  const index = state.sessions.findIndex((item) => item.id === session.id);
  if (index >= 0) {
    state.sessions[index] = session;
  } else {
    state.sessions.unshift(session);
  }
}

/** 根据可用 runner 和当前会话，保证下拉框始终选中一个可运行项。 */
export function ensureRunnerSelection(session: AgentSession | null): void {
  const available = state.runnerOptions.filter((option) => option.available);
  const isValid = (id: string | null): boolean => Boolean(id) && available.some((option) => option.id === id);
  if (!isValid(state.selectedRunnerId)) {
    const fromSession = session && isValid(session.runnerId) ? session.runnerId : null;
    state.selectedRunnerId = fromSession ?? available[0]?.id ?? null;
    state.cliModel = "";
  }
}

export function currentRunner(): RunnerOption | null {
  return state.runnerOptions.find((option) => option.id === state.selectedRunnerId) ?? null;
}

export function runnerLabel(): string {
  return currentRunner()?.label ?? "助手";
}

export function resetProviderForm(): void {
  state.editingProviderId = null;
  state.providerFormOpen = false;
  state.providerError = null;
  state.providerModelBusy = false;
  state.providerModelError = null;
  state.providerModelCandidates = [];
  state.providerForm = blankProviderForm();
}

/** 把模型 textarea 内容解析为去重、去空的 id 列表。 */
export function parseModelsField(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of state.providerForm.models.split(/[\n,]/)) {
    const value = raw.trim();
    if (value && !seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}
