import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentId } from "../../agentdock/runtime/types.js";
import type { ServerContext } from "../context.js";
import { readJson, sendJson } from "../http.js";

/** 环境和本机 Agent 设置 API。 */
export async function handleEnvironmentRoutes(
  method: string,
  pathname: string,
  request: IncomingMessage,
  response: ServerResponse,
  context: ServerContext,
): Promise<boolean> {
  if (method === "GET" && pathname === "/api/environment") {
    sendJson(response, 200, { items: await context.environmentService.detectEnvironment() });
    return true;
  }

  if (method === "POST" && pathname === "/api/environment/install") {
    const body = await readJson<{ target?: string; missingOnly?: boolean }>(request);
    const results = await context.environmentService.installEnvironment(body.target ?? "missing", body.missingOnly !== false);
    sendJson(response, 200, { results, items: await context.environmentService.detectEnvironment() });
    return true;
  }

  if (method === "GET" && pathname === "/api/agent-options") {
    sendJson(response, 200, { agents: await context.environmentService.detectAgentOptions() });
    return true;
  }

  if (method === "POST" && pathname === "/api/agents/install") {
    const body = await readJson<{ target?: string; missingOnly?: boolean }>(request);
    const results = await context.environmentService.installAgents(body.target ?? "missing", body.missingOnly !== false);
    sendJson(response, 200, { results, agents: await context.environmentService.detectAgentOptions() });
    return true;
  }

  if (method === "POST" && pathname === "/api/agents/enable") {
    const body = await readJson<{ agent?: string; enabled?: boolean }>(request);
    const agent = parseAgentId(body.agent);
    if (!agent) {
      sendJson(response, 400, { error: "未知 agent" });
      return true;
    }
    context.setAgentEnabled(agent, body.enabled === true);
    sendJson(response, 200, { agents: await context.environmentService.detectAgentOptions() });
    return true;
  }

  if (method === "POST" && pathname === "/api/agents/model") {
    const body = await readJson<{ agent?: string; model?: string }>(request);
    const agent = parseAgentId(body.agent);
    if (!agent) {
      sendJson(response, 400, { error: "未知 agent" });
      return true;
    }
    context.setAgentModel(agent, String(body.model ?? "").trim() || null);
    sendJson(response, 200, { agents: await context.environmentService.detectAgentOptions() });
    return true;
  }

  return false;
}

function parseAgentId(value: unknown): AgentId | undefined {
  const allowed: AgentId[] = ["codex", "claude", "opencode", "hermes", "qwen", "kimi", "goose"];
  return typeof value === "string" && allowed.includes(value as AgentId) ? (value as AgentId) : undefined;
}
