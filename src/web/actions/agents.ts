import { refreshRunners } from "./runners.js";
import { api } from "../api.js";
import { JSON_HEADERS, state } from "../state.js";
import type { AgentOption, InstallResult } from "../types.js";

export type AgentActionHooks = { render(): void };
let hooks: AgentActionHooks = { render: () => undefined };

export function setAgentActionHooks(next: AgentActionHooks): void {
  hooks = next;
}

export async function refreshAgentOptions(options: { silent?: boolean } = {}): Promise<void> {
  if (!options.silent) {
    state.agentBusy = true;
    hooks.render();
  }
  try {
    const data = await api<{ agents: AgentOption[] }>("/api/agent-options");
    state.agentOptions = data.agents;
    await refreshRunners().catch(() => undefined);
  } finally {
    if (!options.silent) {
      state.agentBusy = false;
    }
    hooks.render();
  }
}

export async function installAgent(target: string): Promise<void> {
  if (!target) {
    return;
  }
  state.agentBusy = true;
  hooks.render();
  try {
    const data = await api<{ agents: AgentOption[]; results: InstallResult[] }>("/api/agents/install", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ target, missingOnly: target === "missing" }),
    });
    state.agentOptions = data.agents;
    state.agentInstallResults = data.results;
    await refreshRunners().catch(() => undefined);
  } finally {
    state.agentBusy = false;
    hooks.render();
  }
}

export async function setAgentEnabled(agent: string, enabled: boolean): Promise<void> {
  if (!agent) {
    return;
  }
  state.agentBusy = true;
  hooks.render();
  try {
    const data = await api<{ agents: AgentOption[] }>("/api/agents/enable", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ agent, enabled }),
    });
    state.agentOptions = data.agents;
    await refreshRunners().catch(() => undefined);
  } finally {
    state.agentBusy = false;
    hooks.render();
  }
}

export async function setAgentDefaultModel(agent: string, model: string): Promise<void> {
  if (!agent) {
    return;
  }
  state.agentBusy = true;
  hooks.render();
  try {
    const data = await api<{ agents: AgentOption[] }>("/api/agents/model", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ agent, model }),
    });
    state.agentOptions = data.agents;
    await refreshRunners().catch(() => undefined);
  } finally {
    state.agentBusy = false;
    hooks.render();
  }
}
