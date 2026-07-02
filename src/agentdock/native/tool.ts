// L2 工具层：统一 Tool 接口 + ToolRegistry + createTool。
//
// 工具错误以结构化 { output, isError:true } 返回，绝不 throw 出去。

import type { JsonSchema, ToolSpec } from "./types.js";
// 仅取类型：runtime/types.js 是零依赖叶子模块（不 import 任何 native 文件），
// 故这里的 import type 既不会在运行时留下依赖，也不可能形成 import 环。
import type { AgentEvent, RunnerRef } from "../runtime/types.js";

/** 子 agent 派发选项（task 工具透传给 driver 注入的 dispatch）。 */
export interface DispatchOptions {
  /** 子 agent 的委派深度（= 父 depth + 1），用于递归封顶。 */
  depth: number;
  /** 可选：子任务的一句话描述，供展示 / 日志。 */
  description?: string;
}

/**
 * 子 agent 派发能力：把一个子任务交给某个 Runner 执行，流式回吐其 AgentEvent。
 * ref 为 null 表示「用与当前完全相同的原生 runner」（由 driver 兜底填充）。
 * 由 driver 在构造 loop 时注入；native 层自身不静态依赖 runtime/driver-registry，避免 import 环。
 */
export type DispatchFn = (
  ref: RunnerRef | null,
  prompt: string,
  opts: DispatchOptions,
) => AsyncGenerator<AgentEvent>;

/** 工具执行上下文。ask() 是策略审批的接缝（L5）；dispatch/depth 是子 agent 派发接缝（L6）。 */
export interface ToolContext {
  sessionId: string;
  cwd: string;
  signal?: AbortSignal;
  ask(req: { tool: string; args: unknown; title?: string }): Promise<{ approved: boolean; reason?: string }>;
  /** 当前 agent 的委派深度（根 agent = 0）；task 工具据此做递归封顶。 */
  depth?: number;
  /** 子 agent 派发能力（由 driver 注入）；未注入时 task 工具结构化报错，绝不 throw。 */
  dispatch?: DispatchFn;
}

/** 工具执行结果。isError 为结构化错误标记。 */
export interface ToolResultData {
  output: string;
  isError?: boolean;
  title?: string;
}

/** 统一工具接口。 */
export interface Tool {
  name: string;
  description: string;
  parameters: JsonSchema;
  annotations?: { readOnly?: boolean; destructive?: boolean };
  execute(args: unknown, ctx: ToolContext): Promise<ToolResultData>;
}

/**
 * 构造工具：校验 parameters 声明为 object 类型（工具参数必须是对象）。
 * 若 parameters.type 不是 "object" 则抛错（这是开发期契约错误，允许 throw）。
 */
export function createTool(def: Tool): Tool {
  const type = def.parameters["type"];
  if (type !== "object") {
    throw new Error(`工具 "${def.name}" 的 parameters.type 必须为 "object"，实际为 ${JSON.stringify(type)}`);
  }
  return def;
}

/** 工具注册表：注册 / 查询 / 列举 / 导出 ToolSpec。 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  specs(): ToolSpec[] {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }
}
