import type { IncomingMessage, ServerResponse } from "node:http";
import { fetchProviderModels, UpstreamModelError } from "../../agentdock/config/model-fetcher.js";
import type { ProviderFormat } from "../../agentdock/runtime/types.js";
import type { ServerContext } from "../context.js";
import { readJson, sendJson } from "../http.js";

/** Provider API：配置 API 后端、删除配置、按凭据拉取模型列表。 */
export async function handleProviderRoutes(
  method: string,
  pathname: string,
  request: IncomingMessage,
  response: ServerResponse,
  context: ServerContext,
): Promise<boolean> {
  if (method === "GET" && pathname === "/api/providers") {
    sendJson(response, 200, { providers: context.providerStore.listSanitized() });
    return true;
  }

  if (method === "POST" && pathname === "/api/providers") {
    const body = await readJson<{
      id?: string;
      label?: string;
      format?: string;
      baseUrl?: string;
      apiKeyEnv?: string;
      apiKey?: string;
      models?: unknown;
    }>(request);
    try {
      context.providerStore.upsert({
        id: String(body.id ?? "").trim(),
        label: body.label,
        format: body.format as ProviderFormat,
        baseUrl: body.baseUrl,
        apiKeyEnv: body.apiKeyEnv,
        apiKey: body.apiKey,
        models: Array.isArray(body.models) ? body.models.map((model) => String(model)) : [],
      });
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
      return true;
    }
    sendJson(response, 200, { providers: context.providerStore.listSanitized() });
    return true;
  }

  if (method === "POST" && pathname === "/api/providers/models") {
    await routeFetchProviderModels(request, response, context);
    return true;
  }

  const providerMatch = pathname.match(/^\/api\/providers\/([^/]+)$/);
  if (providerMatch && method === "DELETE") {
    const providerId = decodeURIComponent(providerMatch[1] ?? "");
    context.providerStore.remove(providerId);
    sendJson(response, 200, { providers: context.providerStore.listSanitized() });
    return true;
  }

  return false;
}

async function routeFetchProviderModels(
  request: IncomingMessage,
  response: ServerResponse,
  context: ServerContext,
): Promise<void> {
  const body = await readJson<{
    id?: string;
    format?: string;
    baseUrl?: string;
    apiKey?: string;
    apiKeyEnv?: string;
  }>(request);

  const format = body.format as ProviderFormat | undefined;
  if (!format || !["openai-chat", "openai-responses", "anthropic"].includes(format)) {
    sendJson(response, 400, { error: "format 无效" });
    return;
  }

  // 密钥优先级：表单新填 > 已保存 provider > 指定环境变量。
  let apiKey = body.apiKey?.trim();
  if (!apiKey && body.id) {
    const existing = context.providerStore.get(String(body.id).trim());
    if (existing) {
      apiKey = context.providerStore.resolveKey(existing);
    }
  }
  if (!apiKey && body.apiKeyEnv) {
    const fromEnv = process.env[body.apiKeyEnv.trim()];
    if (fromEnv && fromEnv.trim()) {
      apiKey = fromEnv.trim();
    }
  }
  if (!apiKey) {
    sendJson(response, 400, { error: "未解析到 API Key：请填写 Key、配置环境变量，或先保存该供应商" });
    return;
  }

  try {
    const models = await fetchProviderModels({ format, apiKey, baseUrl: body.baseUrl });
    sendJson(response, 200, { models });
  } catch (error) {
    if (error instanceof UpstreamModelError) {
      sendJson(response, 502, { error: error.message });
    } else {
      sendJson(response, 502, {
        error: "拉取模型失败：" + (error instanceof Error ? error.message : String(error)),
      });
    }
  }
}
