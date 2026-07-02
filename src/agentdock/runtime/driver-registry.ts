import { ApiAgentDriver } from "../adapters/api/api-driver.js";
import { ClaudeCliDriver } from "../adapters/claude/claude-cli-driver.js";
import { CodexAgentDriver } from "../adapters/codex/codex-driver.js";
import type { ProviderStore } from "../config/provider-store.js";
import { NativeAgentDriver } from "../native/driver.js";
import type { AgentDriver, ProviderConfig, RunnerRef } from "./types.js";

/** DriverRegistry.resolve 的返回：拿到 driver（及 api 的 effective provider）或错误说明。 */
export type ResolvedDriver = {
  driver?: AgentDriver;
  provider?: ProviderConfig;
  error?: string;
};

/**
 * 把一个 RunnerRef 解析成可运行的 driver。
 * - cli:codex / cli:claude 复用同一个有状态实例（线程/会话续接）。
 * - api:<provider>::<model> 共用一个 ApiAgentDriver，并把解析后的密钥塞进 effective provider。
 * - orchestrator 不在此解析（由 AgentService 特判）。
 */
export class DriverRegistry {
  private readonly codexDriver = new CodexAgentDriver();
  private readonly claudeDriver = new ClaudeCliDriver();
  private readonly apiDriver = new ApiAgentDriver();
  /** 原生 driver 需要本 registry 才能让 task 工具派发子 agent，故在构造函数里注入 this。 */
  private readonly nativeDriver: NativeAgentDriver;

  constructor(private readonly providerStore: ProviderStore) {
    this.nativeDriver = new NativeAgentDriver(this);
  }

  resolve(ref: RunnerRef): ResolvedDriver {
    if (ref.kind === "orchestrator") {
      return { error: "编排 runner 不由 DriverRegistry 解析。" };
    }

    if (ref.kind === "cli") {
      if (ref.agent === "codex") {
        return { driver: this.codexDriver };
      }
      if (ref.agent === "claude") {
        return { driver: this.claudeDriver };
      }
      return { error: `CLI agent "${ref.agent}" 暂无可用 driver（仅支持 codex / claude）。` };
    }

    // api / native 都按 provider+model 解析，附上生效密钥。
    const provider = this.providerStore.get(ref.provider);
    if (!provider) {
      return { error: `未找到 provider "${ref.provider}"，请在设置里先配置。` };
    }
    const effective: ProviderConfig = {
      ...provider,
      apiKey: this.providerStore.resolveKey(provider),
    };
    if (ref.kind === "native") {
      return { driver: this.nativeDriver, provider: effective };
    }
    return { driver: this.apiDriver, provider: effective };
  }
}
