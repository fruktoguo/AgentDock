// L5 策略层：纯函数 assess 决定工具是否需审批（真实规则，替换原恒 auto 的 stub）。
//
// 设计要点：
//   - assess 是纯函数，只看传入的 PolicyInput + PolicyConfig，绝不读全局/单例（载重不变量 #2）。
//   - 分级三态：auto（自动放行）/ ask（经 ctx.ask 走审批 UI 接缝）/ reject（硬拒绝，即便审批也不放行）。
//   - 分级规则：
//       * read/grep/glob（annotations.readOnly）           -> auto
//       * write/edit：目标在工作区(workspace)内 -> auto；越出 -> ask
//       * bash：交给 sandbox.classifyBash 按命令分类（只读白名单 auto，危险模式 reject，不确定 ask）
//   - 沙箱护栏与命令分类的实现放在 sandbox.ts；本文件只做「工具 -> 决策」的组合。
//   - 闸门在 L1 循环：assess 返回 reject -> 直接结构化拒绝；返回 ask -> 经 ctx.ask 审批接缝。

import { classifyBash, fencePath } from "./sandbox.js";
import type { Tool, ToolContext } from "./tool.js";

/** 审批决策：自动放行 / 需询问 / 直接拒绝。 */
export type Decision = "auto" | "ask" | "reject";

/**
 * 策略模式：
 *   - "auto"     ：yolo 逃生舱，一切放行（deny 名单仍生效）。
 *   - "strict"   ：默认。只读 auto；工作区内写 auto、越界写 ask；bash 按命令分类。
 *   - "readonly" ：最严。仅只读操作 auto；任何写/改一律 ask；危险命令 reject。
 */
export type PolicyMode = "auto" | "strict" | "readonly";

/**
 * 策略配置。由 driver 构造（workspace = 本轮 cwd，mode 可由环境覆盖）并透传给 loop。
 * allow/deny 是按「工具名」的附加名单，deny 优先级最高（命中即 reject）。
 */
export interface PolicyConfig {
  mode: PolicyMode;
  /** 工作区根：路径围栏基准（write/edit/bash 重定向据此判定越界）。 */
  workspace: string;
  /** 附加白名单（工具名）：显式放行（在只读判定之后、细则之前生效）。 */
  allow: string[];
  /** 附加黑名单（工具名）：命中即 reject（优先级最高）。 */
  deny: string[];
}

/**
 * 策略输入。持有完整 Tool 对象，便于规则读取 annotations（destructive/readOnly）
 * 与工具名、参数做细粒度判定。由 L1 循环在执行前构造并传入。
 */
export interface PolicyInput {
  tool: Tool;
  args: unknown;
}

/** 构造默认策略配置：mode 默认 "strict"，工作区为传入根，allow/deny 为空。可用 overrides 局部覆盖。 */
export function defaultPolicyConfig(workspace: string, overrides?: Partial<PolicyConfig>): PolicyConfig {
  return { mode: "strict", workspace, allow: [], deny: [], ...overrides };
}

/** 从 args 里安全取出 path 字段（write/edit 用）。 */
function readPath(args: unknown): string | undefined {
  const p = (args as { path?: unknown } | null | undefined)?.path;
  return typeof p === "string" && p.length > 0 ? p : undefined;
}

/** 从 args 里安全取出 command 字段（bash 用）。 */
function readCommand(args: unknown): string | undefined {
  const c = (args as { command?: unknown } | null | undefined)?.command;
  return typeof c === "string" && c.trim().length > 0 ? c : undefined;
}

/** write/edit 分级：越界或参数异常 -> ask；工作区内在 strict 下 auto、readonly 下仍 ask。 */
function assessWrite(args: unknown, config: PolicyConfig): Decision {
  const path = readPath(args);
  if (path === undefined) return "ask"; // 参数异常：收紧（工具自身也会结构化报错）
  const { within } = fencePath(config.workspace, path);
  if (!within) return "ask"; // 越出工作区 -> 需审批
  return config.mode === "readonly" ? "ask" : "auto"; // readonly 禁止一切自动写入
}

/** bash 分级：交给沙箱命令分类器；readonly 模式下把非只读（ask）也保持 ask、危险仍 reject。 */
function assessBash(args: unknown, config: PolicyConfig): Decision {
  const command = readCommand(args);
  if (command === undefined) return "ask"; // 参数异常：收紧
  const { decision } = classifyBash(command, config.workspace);
  // classifyBash 已返回 auto/ask/reject；readonly 模式无需额外收紧（其 auto 即纯只读命令）。
  return decision;
}

/**
 * 评估一次工具调用的策略。纯函数，决策只由 (input, config) 决定。
 *
 * 优先级：deny 名单 -> auto 模式 -> 只读工具 -> allow 名单 -> 按工具名细则 -> 默认收紧。
 */
export function assess(input: PolicyInput, config: PolicyConfig): Decision {
  const { tool, args } = input;
  const name = tool.name;

  // deny 名单优先级最高：命中即硬拒绝（即便 auto 模式也拦）。
  if (config.deny.includes(name)) return "reject";

  // yolo 逃生舱：auto 模式全放行。
  if (config.mode === "auto") return "auto";

  // 只读工具（read/grep/glob）：任何模式均 auto。
  if (tool.annotations?.readOnly) return "auto";

  // 附加白名单：显式放行。
  if (config.allow.includes(name)) return "auto";

  // 按工具名细则。
  switch (name) {
    case "write":
    case "edit":
      return assessWrite(args, config);
    case "bash":
      return assessBash(args, config);
    default:
      // 其余工具（如 task/skill/MCP 工具）：readonly 模式收紧为 ask；
      // strict 模式对破坏性工具 ask、非破坏性 auto。
      if (config.mode === "readonly") return "ask";
      return tool.annotations?.destructive ? "ask" : "auto";
  }
}

/**
 * 把决策回调包成 ToolContext["ask"]，作为审批接缝（UI seam）。
 *
 * 注意：ctx.ask 在调用点只拿得到工具「名字」+ 参数（见 ToolContext.ask 签名），
 * 拿不到完整 Tool 对象；这与交互式审批 UI 的真实约束一致（UI 只需名字/参数）。
 *
 * 决策映射：
 *   - "auto"   -> { approved: true }
 *   - "reject" -> { approved: false, reason }
 *   - "ask"    -> headless 骨架下无交互 UI，暂自动放行，并在 reason 里标注这是后续 UI 接缝。
 *
 * 说明：真实的分级判定发生在 loop 里的 assess()（reject 已在闸门被硬拦）；makeAsk 仅是
 * 「把最终决策/用户确认转成 approved」的适配器，回调可整体替换以接入真实审批器。
 */
export function makeAsk(
  decide: (req: { tool: string; args: unknown; title?: string }) => Decision,
): ToolContext["ask"] {
  return async (req) => {
    const decision = decide(req);
    switch (decision) {
      case "auto":
        return { approved: true };
      case "reject":
        return { approved: false, reason: `策略拒绝执行工具: ${req.tool}` };
      case "ask":
        // 后续 UI 接缝：真实实现在此挂起等待用户确认；骨架阶段自动放行。
        return { approved: true, reason: "交互审批 UI 尚未接入，暂自动放行（后续接缝）" };
    }
  };
}
