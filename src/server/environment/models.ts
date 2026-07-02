import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentId } from "../../agentdock/runtime/types.js";
import type { AgentModelOption } from "../types.js";
import { runShell } from "./shell.js";

export type AgentModelDetection = {
  models: AgentModelOption[];
  source: string;
  supportsFreeformModel: boolean;
};

/**
 * 探测本机 Agent 可选模型。
 * 优先读取 CLI 缓存/配置；只有确定存在非交互命令时才运行命令，避免阻塞 Web 请求。
 */
export async function detectAgentModels(agent: AgentId, rootDir: string): Promise<AgentModelDetection> {
  if (agent === "codex") {
    const fromCache = await readCodexModelCache();
    if (fromCache.length > 0) {
      return {
        models: fromCache,
        source: "~/.codex/models_cache.json",
        supportsFreeformModel: true,
      };
    }
    const currentModel = await readCurrentModelFromConfig("codex");
    return {
      models: currentModel ? [{ id: currentModel, label: currentModel, source: "config" }] : [],
      source: currentModel ? "~/.codex/config.toml" : "Codex CLI 未返回可解析模型目录",
      supportsFreeformModel: true,
    };
  }

  if (agent === "opencode") {
    const result = await runShell("opencode models", rootDir, 15_000);
    const models = parseLineModels(result.output);
    return {
      models,
      source: models.length > 0 ? "opencode models" : "OpenCode 未返回模型列表",
      supportsFreeformModel: true,
    };
  }

  if (agent === "hermes") {
    const models = await readHermesModels();
    const currentModel = await readCurrentModelFromConfig("hermes");
    const merged = mergeModels([
      ...models,
      ...(currentModel ? [{ id: currentModel, label: currentModel, source: "config" as const }] : []),
    ]);
    return {
      models: merged,
      source: merged.length > 0 ? "~/.hermes/config.yaml / ~/.hermes/models_dev_cache.json" : "Hermes 未发现非交互模型列表",
      supportsFreeformModel: true,
    };
  }

  const configuredModel = await readCurrentModelFromConfig(agent);
  return {
    models: configuredModel ? [{ id: configuredModel, label: configuredModel, source: "config" }] : [],
    source: configuredModel ? "本机配置" : "该 agent 未发现非交互模型列表命令",
    supportsFreeformModel: true,
  };
}

async function readCodexModelCache(): Promise<AgentModelOption[]> {
  const home = process.env.HOME;
  if (!home) {
    return [];
  }
  const raw = await readOptionalFile(join(home, ".codex/models_cache.json"));
  if (!raw) {
    return [];
  }
  const parsed = parseJsonRecord(raw);
  const models = Array.isArray(parsed?.models) ? parsed.models : [];
  return mergeModels(models.flatMap(modelFromRecord));
}

async function readHermesModels(): Promise<AgentModelOption[]> {
  const home = process.env.HOME;
  if (!home) {
    return [];
  }
  const config = await readOptionalFile(join(home, ".hermes/config.yaml"));
  const provider = matchConfigValue(config, "provider");
  const raw = await readOptionalFile(join(home, ".hermes/models_dev_cache.json"));
  const parsed = parseJsonRecord(raw);
  const providerRecord = provider && isRecord(parsed?.[provider]) ? parsed[provider] : undefined;
  const modelsRecord = isRecord(providerRecord?.models) ? providerRecord.models : undefined;
  if (!modelsRecord) {
    return [];
  }
  return mergeModels(
    Object.values(modelsRecord).flatMap((model) => {
      if (!isRecord(model)) {
        return [];
      }
      const id = typeof model.id === "string" ? model.id : undefined;
      if (!id) {
        return [];
      }
      const label = typeof model.name === "string" ? model.name : id;
      const fullId = provider ? `${provider}/${id}` : id;
      return [{ id: fullId, label, source: "agent" as const }];
    }),
  );
}

/** 读取 CLI 当前默认模型，作为检测不到模型列表时的兜底候选。 */
export async function readCurrentModelFromConfig(agent: AgentId): Promise<string | null> {
  const home = process.env.HOME;
  if (!home) {
    return null;
  }
  if (agent === "codex") {
    const config = await readOptionalFile(join(home, ".codex/config.toml"));
    return matchTomlString(config, "model");
  }
  if (agent === "hermes") {
    const config = await readOptionalFile(join(home, ".hermes/config.yaml"));
    const provider = matchConfigValue(config, "provider");
    const model = matchConfigValue(config, "default") ?? matchConfigValue(config, "model");
    if (provider && model && !model.includes("/")) {
      return `${provider}/${model}`;
    }
    return model;
  }
  return null;
}

function parseLineModels(output: string): AgentModelOption[] {
  return mergeModels(
    output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("Usage:") && !line.startsWith("Error:"))
      .map((line) => ({ id: line, label: line, source: "agent" as const })),
  );
}

function modelFromRecord(value: unknown): AgentModelOption[] {
  if (!isRecord(value)) {
    return [];
  }
  const id = typeof value.slug === "string" ? value.slug : typeof value.id === "string" ? value.id : undefined;
  if (!id) {
    return [];
  }
  const label = typeof value.display_name === "string" ? value.display_name : typeof value.name === "string" ? value.name : id;
  return [{ id, label, source: "agent" }];
}

function mergeModels(models: AgentModelOption[]): AgentModelOption[] {
  const seen = new Set<string>();
  const result: AgentModelOption[] = [];
  for (const model of models) {
    if (seen.has(model.id)) {
      continue;
    }
    seen.add(model.id);
    result.push(model);
  }
  return result.sort((left, right) => left.label.localeCompare(right.label));
}

async function readOptionalFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

function parseJsonRecord(raw: string | null): Record<string, unknown> | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function matchTomlString(raw: string | null, key: string): string | null {
  if (!raw) {
    return null;
  }
  const match = raw.match(new RegExp(`^${escapeRegExp(key)}\\s*=\\s*"([^"]+)"`, "m"));
  return match?.[1] ?? null;
}

function matchConfigValue(raw: string | null, key: string): string | null {
  if (!raw) {
    return null;
  }
  const match = raw.match(new RegExp(`^\\s*${escapeRegExp(key)}:\\s*['"]?([^'"\\n#]+)`, "m"));
  return match?.[1]?.trim() || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
