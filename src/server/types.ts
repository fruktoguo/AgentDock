import type { AgentId } from "../agentdock/runtime/types.js";

/**
 * 服务端环境检测目标：既可描述基础环境，也可描述本机 Agent CLI。
 * detectCommand 必须是非交互命令；installCommand 只在用户主动触发安装时执行。
 */
export type EnvironmentTarget = {
  id: string;
  name: string;
  binary?: string;
  detectCommand: string;
  installCommand: string;
  cwd?: string;
  description: string;
};

/** 前端设置页展示的基础环境状态。 */
export type EnvironmentStatus = {
  id: string;
  name: string;
  installed: boolean;
  installable: boolean;
  busy: boolean;
  detail: string;
  installCommand: string;
  description: string;
};

/** 安装命令的结构化执行结果，output 已在服务端截断。 */
export type InstallResult = {
  id: string;
  name: string;
  ok: boolean;
  code: number | null;
  output: string;
};

/** 从本机 CLI 配置或缓存里检测到的模型候选。 */
export type AgentModelOption = {
  id: string;
  label: string;
  source: "agent" | "config";
};

/** 前端设置页展示的本机 Agent 状态。 */
export type AgentOption = {
  id: AgentId;
  name: string;
  installed: boolean;
  enabled: boolean;
  installable: boolean;
  busy: boolean;
  runnable: boolean;
  detail: string;
  installCommand: string;
  description: string;
  models: AgentModelOption[];
  defaultModel: string | null;
  modelSource: string;
  supportsFreeformModel: boolean;
};
