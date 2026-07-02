// L6 子 agent 工具：task —— 把一个子任务委派给任意 Runner（native / api / cli / orchestrator）。
//
// 这是本产品的核心 IP：运行中的原生 agent 可以把可独立完成的子问题外包给「子 agent」。
// 层次干净的关键：本工具「不」静态依赖 runtime/driver-registry（那会把 native/driver 反向拉回成环），
// 只调用 ctx.dispatch —— 由 driver 在构造 loop 时注入的派发能力。driver 本就 import runtime，负责接线。
// 递归深度守卫：透传 depth，封顶 MAX_DISPATCH_DEPTH，超限时返回结构化错误，杜绝无限委派。
// 所有失败路径均返回结构化 { output, isError:true }，绝不 throw 到 loop 外。

import { createTool, type Tool } from "../tool.js";
import type { ToolContext, ToolResultData } from "../tool.js";
// 仅从 runtime 的零依赖叶子模块 types.js 取 RunnerRef 类型与 decodeRunner 编解码器。
// types.js 不 import 任何 native 文件，故此处的值导入不可能形成 import 环。
import { decodeRunner, type RunnerRef } from "../../runtime/types.js";

/** 子 agent 委派的最大嵌套深度（根 agent=0，故最深的子 agent 处于 depth=MAX_DISPATCH_DEPTH）。 */
export const MAX_DISPATCH_DEPTH = 3;

/** 子 agent 最终文本回传上限（字符），超出则尾部截断并标注。 */
const MAX_OUTPUT_CHARS = 16_000;

/** 有界截断：保留头部，超长时追加省略标注。 */
function bound(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}\n…（子 agent 输出过长，已截断，原文共 ${text.length} 字符）`;
}

/**
 * 创建 task 工具。工具体与 runtime 层解耦：真正的派发由 ctx.dispatch 完成（driver 注入）。
 * 缺 dispatch（headless / 未接线）或超出深度封顶时结构化报错。
 */
export function createTaskTool(): Tool {
  return createTool({
    name: "task",
    description:
      "把一个子任务委派给一个子 agent（Runner）并等待其完成，返回子 agent 的最终答复文本。" +
      "适合把可独立完成的子问题外包出去。runner 缺省 = 与你相同的原生 runner；" +
      "也可指定编码后的 runner id：native:<provider>::<model> / api:<provider>::<model> / cli:codex / cli:claude。" +
      `注意会递归封顶（最多嵌套 ${MAX_DISPATCH_DEPTH} 层）；子 agent 会开一个全新会话（不共享你的上下文，请在 prompt 里给足信息）。`,
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "交给子 agent 的完整任务指令。子 agent 看不到你的对话历史，务必自包含。",
        },
        runner: {
          type: "string",
          description:
            "可选。子 agent 的 runner id（编码后的 RunnerRef）。缺省 = 复用与你相同的原生 runner。",
        },
        description: {
          type: "string",
          description: "可选。对该子任务的一句话描述，用于展示 / 日志。",
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResultData> {
      const a = (args ?? {}) as { prompt?: unknown; runner?: unknown; description?: unknown };

      // 入参校验。
      if (typeof a.prompt !== "string" || a.prompt.trim().length === 0) {
        return { output: "prompt 必须为非空字符串。", isError: true };
      }
      const description =
        typeof a.description === "string" && a.description.trim().length > 0
          ? a.description.trim()
          : undefined;

      // 递归深度守卫：先于任何派发检查，超限直接结构化拒绝，杜绝无限委派。
      const depth = ctx.depth ?? 0;
      if (depth >= MAX_DISPATCH_DEPTH) {
        return {
          output: `子 agent 委派已达最大嵌套深度 ${MAX_DISPATCH_DEPTH}（当前 depth=${depth}），拒绝继续委派以防无限递归。`,
          isError: true,
        };
      }

      // 派发能力守卫：未注入（headless / 未接线）时结构化报错。
      if (!ctx.dispatch) {
        return {
          output: "当前运行环境未提供子 agent 派发能力（ctx.dispatch 未注入），无法使用 task 工具。",
          isError: true,
        };
      }

      // 解析 runner：缺省 = null（由 driver 兜底为同模型 native）；给了但非法则结构化报错。
      let ref: RunnerRef | null = null;
      if (typeof a.runner === "string" && a.runner.trim().length > 0) {
        ref = decodeRunner(a.runner.trim());
        if (!ref) {
          return {
            output:
              `无法解析 runner id "${a.runner}"。合法形如 native:<provider>::<model> / ` +
              `api:<provider>::<model> / cli:codex / cli:claude / orchestrator。`,
            isError: true,
          };
        }
      }

      // 派发子 agent 并 drain 其 AgentEvent，抽取最终助手文本（= 最后一条非空 message 事件）。
      const childDepth = depth + 1;
      let finalText = "";
      let lastError = "";
      try {
        for await (const ev of ctx.dispatch(ref, a.prompt, { depth: childDepth, description })) {
          if (ev.kind === "message") {
            if (ev.body.trim().length > 0) {
              finalText = ev.body;
            }
          } else if (ev.kind === "error") {
            lastError = ev.body.trim() || ev.title;
          }
        }
      } catch (err) {
        // 防御：子系统本应结构化返回，这里把意外异常也转成结构化错误，不外抛。
        const message = err instanceof Error ? err.message : String(err);
        return { output: `子 agent 执行异常：${message}`, isError: true };
      }

      const trimmed = finalText.trim();

      // 子 agent 报错时绝不静默当成功：driver 的 error 分支会先 flush 已累积文本、再吐 error
      //（case "error"：yield* flush(); yield error），故子 agent「产出部分文本后又报错」时
      // finalText 与 lastError 会同时非空。此处必须优先按失败上报，避免残缺文本被父 agent
      // 当作完整答案；已产出的部分文本一并附回，便于父 agent 判断与追溯。
      if (lastError) {
        return {
          output: trimmed
            ? `子 agent 报错：${lastError}\n已产出的部分文本：${bound(trimmed, MAX_OUTPUT_CHARS)}`
            : `子 agent 未产出最终文本，报错：${lastError}`,
          isError: true,
        };
      }

      if (trimmed.length === 0) {
        return {
          output: "子 agent 未产出任何最终文本。",
          isError: true,
        };
      }

      return {
        output: bound(trimmed, MAX_OUTPUT_CHARS),
        title: description ? `子任务：${description}` : "子 agent 结果",
      };
    },
  });
}
