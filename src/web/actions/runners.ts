import { api } from "../api.js";
import { currentSession, ensureRunnerSelection, state } from "../state.js";
import type { RunnerOption } from "../types.js";

/**
 * Runner 刷新服务：集中拉取可用执行体，避免 action 模块反向依赖入口 app.ts。
 * 该模块没有 DOM 副作用，只更新状态，因此可被启动流程、Agent 设置和 Provider 设置复用。
 */
export async function refreshRunners(): Promise<void> {
  const data = await api<{ runners: RunnerOption[] }>("/api/runners");
  state.runnerOptions = data.runners;
  ensureRunnerSelection(currentSession());
}
