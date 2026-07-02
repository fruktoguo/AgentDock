import { api } from "../api.js";
import { JSON_HEADERS, state } from "../state.js";
import type { EnvironmentStatus, InstallResult } from "../types.js";

export type EnvironmentActionHooks = { render(): void };
let hooks: EnvironmentActionHooks;

export function setEnvironmentActionHooks(next: EnvironmentActionHooks): void {
  hooks = next;
}

export async function refreshEnvironment(): Promise<void> {
  state.environmentBusy = true;
  hooks.render();
  try {
    const data = await api<{ items: EnvironmentStatus[] }>("/api/environment");
    state.environmentItems = data.items;
  } finally {
    state.environmentBusy = false;
    hooks.render();
  }
}

export async function installEnvironment(target: string): Promise<void> {
  if (!target) {
    return;
  }
  state.environmentBusy = true;
  hooks.render();
  try {
    const data = await api<{ items: EnvironmentStatus[]; results: InstallResult[] }>("/api/environment/install", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ target, missingOnly: target === "missing" }),
    });
    state.environmentItems = data.items;
    state.installResults = data.results;
  } finally {
    state.environmentBusy = false;
    hooks.render();
  }
}
