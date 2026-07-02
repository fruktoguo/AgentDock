import type { ProviderStore } from "../../agentdock/config/provider-store.js";
import type { AgentSettings } from "../../agentdock/runtime/local-data-store.js";
import { encodeRunner } from "../../agentdock/runtime/types.js";
import type { AgentId, RunnerOption, RunnerRef } from "../../agentdock/runtime/types.js";
import type { AgentOption, EnvironmentStatus, InstallResult } from "../types.js";
import { detectAgentModels, readCurrentModelFromConfig } from "./models.js";
import { agentTargets, environmentTargets } from "./targets.js";
import { runShell, trimOutput } from "./shell.js";

/**
 * 环境域服务：集中处理检测、安装、模型发现和 runner 合成。
 * 路由层只关心输入/输出，不直接拼 shell 命令或读取本机配置。
 */
export class EnvironmentService {
  private readonly runningEnvironmentInstalls = new Set<string>();
  private readonly runningAgentInstalls = new Set<string>();

  constructor(
    private readonly rootDir: string,
    private readonly providerStore: ProviderStore,
    private readonly getAgentSettings: () => AgentSettings,
  ) {}

  async detectEnvironment(): Promise<EnvironmentStatus[]> {
    const items = await Promise.all(
      environmentTargets.map(async (target) => {
        const result = await runShell(target.detectCommand, target.cwd ?? this.rootDir, 15_000);
        const installed = result.code === 0;
        const detail = installed
          ? target.binary
            ? trimOutput(result.output) || `${target.binary} 已可用`
            : "已安装"
          : trimOutput(result.output) || "未检测到";
        return {
          id: target.id,
          name: target.name,
          installed,
          installable: Boolean(target.installCommand),
          busy: this.runningEnvironmentInstalls.has(target.id),
          detail,
          installCommand: target.installCommand,
          description: target.description,
        };
      }),
    );
    return items;
  }

  async detectAgentOptions(): Promise<AgentOption[]> {
    const options: AgentOption[] = [];
    const settings = this.getAgentSettings();
    for (const target of agentTargets) {
      const result = await runShell(target.detectCommand, target.cwd ?? this.rootDir, 15_000);
      const installed = result.code === 0;
      const runnable = target.id === "codex" || target.id === "claude";
      const enabled = installed && runnable && settings[target.id]?.enabled !== false;
      const detail = installed
        ? target.binary
          ? trimOutput(result.output) || `${target.binary} 已可用`
          : "已安装"
        : trimOutput(result.output) || "未检测到";
      const modelInfo = installed
        ? await detectAgentModels(target.id, this.rootDir)
        : { models: [], source: "安装后检测", supportsFreeformModel: true };
      const configuredDefault = installed ? await readCurrentModelFromConfig(target.id) : null;
      const defaultModel = settings[target.id]?.model ?? configuredDefault ?? modelInfo.models[0]?.id ?? null;
      options.push({
        id: target.id,
        name: target.name,
        installed,
        enabled,
        installable: Boolean(target.installCommand),
        busy: this.runningAgentInstalls.has(target.id),
        runnable,
        detail: installed ? `${detail}${runnable ? "" : "\n后端 adapter 尚未接入"}` : detail,
        installCommand: target.installCommand,
        description: target.description,
        models: modelInfo.models,
        defaultModel,
        modelSource: modelInfo.source,
        supportsFreeformModel: modelInfo.supportsFreeformModel,
      });
    }
    return options;
  }

  /** 合并 CLI runner、API runner 和编排 runner，直接供前端下拉框使用。 */
  async listRunners(): Promise<RunnerOption[]> {
    const runners: RunnerOption[] = [];

    const cliHints: Partial<Record<AgentId, string>> = {
      claude: "规划 / 前端 / 审阅",
      codex: "代码实现 / 后端 / 调试",
    };

    const agents = await this.detectAgentOptions();
    for (const agent of agents) {
      if ((agent.id !== "codex" && agent.id !== "claude") || !agent.installed || !agent.enabled || !agent.runnable) {
        continue;
      }
      const ref: RunnerRef = { kind: "cli", agent: agent.id };
      runners.push({
        id: encodeRunner(ref),
        ref,
        backend: "cli",
        label: agent.name,
        group: "本机 CLI",
        capabilityHint: cliHints[agent.id],
        available: true,
        detail: agent.defaultModel ?? undefined,
      });
    }

    for (const provider of this.providerStore.list()) {
      const key = this.providerStore.resolveKey(provider);
      const groupLabel = provider.label ?? provider.id;
      for (const model of provider.models) {
        const ref: RunnerRef = { kind: "api", provider: provider.id, model };
        runners.push({
          id: encodeRunner(ref),
          ref,
          backend: "api",
          label: `${groupLabel} · ${model}`,
          group: groupLabel,
          available: Boolean(key),
          detail: key ? undefined : "未配置密钥",
        });

        // 同一 provider+model 额外提供一个「原生 Agent」runner（带工具循环）。
        const nativeRef: RunnerRef = { kind: "native", provider: provider.id, model };
        runners.push({
          id: encodeRunner(nativeRef),
          ref: nativeRef,
          backend: "api",
          label: `${groupLabel} · ${model} · 原生`,
          group: groupLabel,
          capabilityHint: "原生工具循环：可执行 bash / 读写 / 检索",
          available: Boolean(key),
          detail: key ? "原生 Agent（内置工具）" : "未配置密钥",
        });
      }
    }

    const hasAvailable = runners.some((runner) => runner.available);
    const orchestratorRef: RunnerRef = { kind: "orchestrator" };
    runners.unshift({
      id: encodeRunner(orchestratorRef),
      ref: orchestratorRef,
      backend: "orchestrator",
      label: "编排 Agent",
      group: "编排",
      capabilityHint: "自动拆解任务并派发给最合适的执行体",
      available: hasAvailable,
      detail: hasAvailable ? undefined : "至少需要一个可用的 CLI 或 API runner",
    });

    return runners;
  }

  async installEnvironment(targetId: string, missingOnly: boolean): Promise<InstallResult[]> {
    const statuses = await this.detectEnvironment();
    const statusById = new Map(statuses.map((status) => [status.id, status]));
    const targets =
      targetId === "missing"
        ? environmentTargets.filter((target) => !missingOnly || !statusById.get(target.id)?.installed)
        : environmentTargets.filter((target) => target.id === targetId);
    if (targetId !== "missing" && targets.length === 0) {
      throw new Error(`未知安装目标：${targetId}`);
    }
    return this.installTargets(targets, statusById, missingOnly, this.runningEnvironmentInstalls);
  }

  async installAgents(targetId: string, missingOnly: boolean): Promise<InstallResult[]> {
    const statuses = await this.detectAgentOptions();
    const statusById = new Map(statuses.map((status) => [status.id, status]));
    const targets =
      targetId === "missing"
        ? agentTargets.filter((target) => !missingOnly || !statusById.get(target.id)?.installed)
        : agentTargets.filter((target) => target.id === targetId);
    if (targetId !== "missing" && targets.length === 0) {
      throw new Error(`未知 agent 安装目标：${targetId}`);
    }
    return this.installTargets(targets, statusById, missingOnly, this.runningAgentInstalls);
  }

  private async installTargets(
    targets: typeof environmentTargets,
    statusById: Map<string, { installed: boolean }>,
    missingOnly: boolean,
    runningInstalls: Set<string>,
  ): Promise<InstallResult[]> {
    const results: InstallResult[] = [];
    for (const target of targets) {
      const status = statusById.get(target.id);
      if (missingOnly && status?.installed) {
        results.push({ id: target.id, name: target.name, ok: true, code: 0, output: "已安装，跳过。" });
        continue;
      }
      if (runningInstalls.has(target.id)) {
        results.push({ id: target.id, name: target.name, ok: false, code: null, output: "安装正在运行中。" });
        continue;
      }
      runningInstalls.add(target.id);
      try {
        const result = await runShell(target.installCommand, target.cwd ?? this.rootDir, 600_000);
        results.push({
          id: target.id,
          name: target.name,
          ok: result.code === 0,
          code: result.code,
          output: trimOutput(result.output) || (result.code === 0 ? "安装完成。" : "安装失败。"),
        });
      } finally {
        runningInstalls.delete(target.id);
      }
    }
    return results;
  }
}
