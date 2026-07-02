import { refreshRunners } from "./runners.js";
import { api } from "../api.js";
import { JSON_HEADERS, parseModelsField, resetProviderForm, state } from "../state.js";
import type { SanitizedProvider } from "../types.js";

export type ProviderActionHooks = { render(): void };
let hooks: ProviderActionHooks = { render: () => undefined };

export function setProviderActionHooks(next: ProviderActionHooks): void {
  hooks = next;
}

export async function refreshProviders(): Promise<void> {
  state.providerBusy = true;
  hooks.render();
  try {
    const data = await api<{ providers: SanitizedProvider[] }>("/api/providers");
    state.providers = data.providers;
  } finally {
    state.providerBusy = false;
    hooks.render();
  }
}

export async function saveProvider(): Promise<void> {
  if (!state.providerForm.id.trim()) {
    state.providerError = "请填写 provider id";
    hooks.render();
    return;
  }
  state.providerBusy = true;
  state.providerError = null;
  hooks.render();
  try {
    const models = parseModelsField();
    const data = await api<{ providers: SanitizedProvider[] }>("/api/providers", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        id: state.providerForm.id.trim(),
        label: state.providerForm.label.trim() || undefined,
        format: state.providerForm.format,
        baseUrl: state.providerForm.baseUrl.trim() || undefined,
        apiKeyEnv: state.providerForm.apiKeyEnv.trim() || undefined,
        apiKey: state.providerForm.apiKey,
        models,
      }),
    });
    state.providers = data.providers;
    resetProviderForm();
    await refreshRunners().catch(() => undefined);
  } catch (error) {
    state.providerError = (error as Error).message;
  } finally {
    state.providerBusy = false;
    hooks.render();
  }
}

export async function deleteProvider(id: string): Promise<void> {
  if (!id) {
    return;
  }
  state.providerBusy = true;
  hooks.render();
  try {
    const data = await api<{ providers: SanitizedProvider[] }>(`/api/providers/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    state.providers = data.providers;
    if (state.editingProviderId === id) {
      resetProviderForm();
    }
    await refreshRunners().catch(() => undefined);
  } finally {
    state.providerBusy = false;
    hooks.render();
  }
}

export function editProvider(id: string): void {
  const provider = state.providers.find((item) => item.id === id);
  if (!provider) {
    return;
  }
  state.editingProviderId = provider.id;
  state.providerFormOpen = true;
  state.providerError = null;
  state.providerModelBusy = false;
  state.providerModelError = null;
  state.providerModelCandidates = [];
  state.providerForm = {
    id: provider.id,
    label: provider.label ?? "",
    format: provider.format,
    baseUrl: provider.baseUrl ?? "",
    apiKeyEnv: provider.apiKeyEnv ?? "",
    apiKey: "",
    models: provider.models.join("\n"),
  };
  hooks.render();
}

export async function fetchProviderModelList(): Promise<void> {
  const body = {
    id: state.editingProviderId ?? undefined,
    format: state.providerForm.format,
    baseUrl: state.providerForm.baseUrl.trim() || undefined,
    apiKeyEnv: state.providerForm.apiKeyEnv.trim() || undefined,
    apiKey: state.providerForm.apiKey.trim() ? state.providerForm.apiKey : undefined,
  };
  state.providerModelBusy = true;
  state.providerModelError = null;
  hooks.render();
  try {
    const data = await api<{ models: string[] }>("/api/providers/models", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
    state.providerModelCandidates = data.models;
  } catch (error) {
    state.providerModelError = (error as Error).message;
    state.providerModelCandidates = [];
  } finally {
    state.providerModelBusy = false;
    hooks.render();
  }
}

export function toggleModelInField(id: string): void {
  if (!id) {
    return;
  }
  const list = parseModelsField();
  const index = list.indexOf(id);
  if (index >= 0) {
    list.splice(index, 1);
  } else {
    list.push(id);
  }
  state.providerForm.models = list.join("\n");
  hooks.render();
}

export function selectAllModels(): void {
  const merged = parseModelsField();
  for (const id of state.providerModelCandidates) {
    if (!merged.includes(id)) {
      merged.push(id);
    }
  }
  state.providerForm.models = merged.join("\n");
  hooks.render();
}

export function clearModelsField(): void {
  state.providerForm.models = "";
  hooks.render();
}
