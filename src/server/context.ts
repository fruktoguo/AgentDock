import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ProviderStore } from "../agentdock/config/provider-store.js";
import { AgentService } from "../agentdock/runtime/agent-service.js";
import { DriverRegistry } from "../agentdock/runtime/driver-registry.js";
import { EventBus } from "../agentdock/runtime/event-bus.js";
import { LocalDataStore, type AgentSettings } from "../agentdock/runtime/local-data-store.js";
import { SessionStore } from "../agentdock/runtime/session-store.js";
import type { AgentId } from "../agentdock/runtime/types.js";
import { EnvironmentService } from "./environment/service.js";

export type ServerContext = {
  rootDir: string;
  publicDir: string;
  compiledWebDir: string;
  service: AgentService;
  providerStore: ProviderStore;
  environmentService: EnvironmentService;
  setAgentEnabled(agent: AgentId, enabled: boolean): void;
  setAgentModel(agent: AgentId, model: string | null): void;
};

/**
 * 组装服务端运行上下文。
 * 所有带状态的对象都在这里创建，路由只通过 ServerContext 访问依赖。
 */
export async function createServerContext(): Promise<ServerContext> {
  const rootDir = resolve(fileURLToPath(new URL("../../", import.meta.url)));
  const publicDir = resolve(rootDir, "src/web");
  const compiledWebDir = resolve(rootDir, "dist/web");

  const dataStore = new LocalDataStore();
  const persistedState = await dataStore.load();
  let agentSettings: AgentSettings = persistedState.agents;
  let sessionStore: SessionStore;
  let providerStore: ProviderStore;

  const saveState = () => {
    dataStore.save({
      version: 1,
      sessions: sessionStore.list(),
      agents: agentSettings,
      providers: providerStore.list(),
    });
  };

  sessionStore = new SessionStore(persistedState.sessions, saveState);
  providerStore = new ProviderStore(persistedState.providers, saveState);
  const environmentService = new EnvironmentService(rootDir, providerStore, () => agentSettings);
  const registry = new DriverRegistry(providerStore);
  const service = new AgentService(sessionStore, new EventBus(), providerStore, registry, () => environmentService.listRunners());

  return {
    rootDir,
    publicDir,
    compiledWebDir,
    service,
    providerStore,
    environmentService,
    setAgentEnabled(agent, enabled) {
      agentSettings = {
        ...agentSettings,
        [agent]: { ...agentSettings[agent], enabled },
      };
      saveState();
    },
    setAgentModel(agent, model) {
      agentSettings = {
        ...agentSettings,
        [agent]: { ...agentSettings[agent], model },
      };
      saveState();
    },
  };
}
