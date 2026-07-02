// L1 推理循环：reason -> act -> observe 的纯异步生成器。
//
// 命名约定（下游必须遵守）：
//   - opts.model   : ModelClient 实例（L0 客户端）
//   - opts.modelId : 模型 id 字符串（避免与上面的 model 字段冲突）
//
// 循环职责：步数上限（maxSteps）；doom-loop 守卫（同 tool+args 连续 3 次 -> 停）；
// 显式收尾（模型不再发 tool_call -> done）；流式吐 LoopEvent；尊重 AbortSignal。
// 载重不变量 #2：loop 是对传入 state 的纯生成器，无隐藏可变单例，只吐 delta。

import { compact } from "./compaction.js";
import { assess, defaultPolicyConfig } from "./policy.js";
import type { PolicyConfig } from "./policy.js";
import type { ModelClient } from "./model.js";
import type { DispatchFn, ToolContext, ToolResultData } from "./tool.js";
import type { ToolRegistry } from "./tool.js";
import type { ContentPart, LoopEvent, Message } from "./types.js";

/** runAgentLoop 的入参。 */
export type RunAgentLoopOptions = {
  model: ModelClient;
  registry: ToolRegistry;
  system: string;
  messages: Message[];
  modelId: string;
  cwd: string;
  sessionId: string;
  maxSteps?: number;
  signal?: AbortSignal;
  ask?: ToolContext["ask"];
  /** 模型总上下文（token），来自 ModelMeta.contextLimit；用于 L4 压缩预算，缺省走兜底。 */
  contextLimit?: number;
  /** 当前 agent 的委派深度（根=0），透传给工具 ctx 供 task 递归封顶。 */
  depth?: number;
  /** 子 agent 派发能力，透传给工具 ctx（task 工具用）；由 driver 注入。 */
  dispatch?: DispatchFn;
  /** L5 策略配置（工作区围栏 + 模式 + allow/deny）；缺省用 cwd 构造 strict 默认。 */
  policy?: PolicyConfig;
};

/** 默认步数上限。 */
const DEFAULT_MAX_STEPS = 25;

/** doom-loop 阈值：同一 tool+args 出现该次数即判定死循环。 */
const DOOM_LOOP_LIMIT = 3;

/** 若 signal 已中止则抛出，交由上层 driver 捕获。 */
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("aborted");
  }
}

/** 收集到的待执行工具调用。 */
type PendingCall = { id: string; name: string; args: unknown };

export async function* runAgentLoop(opts: RunAgentLoopOptions): AsyncGenerator<LoopEvent> {
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;

  // 工作消息数组：从入参 seed 一份副本，循环中原地追加（loop 内私有，无外部可变单例）。
  const messages: Message[] = [...opts.messages];

  // doom-loop 计数：key = name + JSON(args)，跨步累计。
  const doomCounts = new Map<string, number>();

  // 兜底 ask：opts.ask 未提供时自动放行，保住策略接缝（headless 下 "ask" 自动放行）。
  const askFn: ToolContext["ask"] = opts.ask ?? (async () => ({ approved: true }));

  // L5 策略配置：opts.policy 未提供时用本轮 cwd 构造 strict 默认（工作区围栏 + 命令分类）。
  const policy: PolicyConfig = opts.policy ?? defaultPolicyConfig(opts.cwd);

  // 最近一次助手文本，供步数上限收尾时兜底。
  let lastText = "";

  for (let step = 0; step < maxSteps; step += 1) {
    checkAbort(opts.signal);

    // ---- reason：向模型请求一次流式响应 ----
    let stepText = "";
    let stepThinking = "";
    const pendingCalls: PendingCall[] = [];
    let sawError = false;

    // L4 非破坏性压缩：仅在发往模型前计算一份「压缩视图」，原始 messages 照旧原地追加。
    // compact 保证 orphan 安全（不拆散 tool_call / tool_result 对），避免真实 Anthropic 400。
    const view = compact(messages, { contextLimit: opts.contextLimit });

    const stream = opts.model.stream({
      system: opts.system,
      messages: view,
      tools: opts.registry.specs(),
      model: opts.modelId,
      signal: opts.signal,
    });

    for await (const ev of stream) {
      switch (ev.kind) {
        case "text_delta": {
          stepText += ev.text;
          // 流式吐文本增量（driver 侧自行累积渲染）。
          yield { kind: "assistant_text", text: ev.text };
          break;
        }
        case "thinking_delta": {
          stepThinking += ev.text;
          yield { kind: "thinking", text: ev.text };
          break;
        }
        case "tool_call": {
          pendingCalls.push({ id: ev.call.id, name: ev.call.name, args: ev.call.args });
          break;
        }
        case "completed": {
          if (ev.usage !== undefined) {
            yield { kind: "usage", usage: ev.usage };
          }
          break;
        }
        case "error": {
          yield { kind: "error", message: ev.message };
          sawError = true;
          break;
        }
        default: {
          // 穷尽联合；未知种类忽略。
          break;
        }
      }
      if (sawError) {
        break;
      }
    }

    if (sawError) {
      return;
    }

    lastText = stepText;

    // ---- 组装本步的 assistant 消息 ----
    const assistantParts: ContentPart[] = [];
    if (stepThinking.length > 0) {
      assistantParts.push({ type: "thinking", text: stepThinking });
    }
    if (stepText.length > 0) {
      assistantParts.push({ type: "text", text: stepText });
    }
    for (const call of pendingCalls) {
      assistantParts.push({ type: "tool_call", id: call.id, name: call.name, args: call.args });
    }
    if (assistantParts.length > 0) {
      messages.push({ role: "assistant", content: assistantParts });
    }

    // ---- 显式收尾：模型不再发 tool_call -> done ----
    if (pendingCalls.length === 0) {
      yield { kind: "done", finalText: stepText };
      return;
    }

    // ---- act + observe：逐个执行工具，结果合并成单条 user 消息 ----
    // 一步内可能有多个 tool_call（parallel tool use）。所有 tool_result 必须放进
    // 同一条 user 消息里回填：否则会产生连续同 role 消息，触发 Anthropic 的
    // "roles must alternate" 400。
    const toolResultParts: ContentPart[] = [];
    for (const call of pendingCalls) {
      checkAbort(opts.signal);

      // doom-loop 守卫：同一 name+args 连续累计到阈值 -> 判定死循环并收尾。
      const key = `${call.name}::${safeStringify(call.args)}`;
      const count = (doomCounts.get(key) ?? 0) + 1;
      doomCounts.set(key, count);
      if (count >= DOOM_LOOP_LIMIT) {
        yield {
          kind: "error",
          message: `检测到 doom loop：工具 "${call.name}" 以相同参数被调用 ${count} 次，已停止。`,
        };
        yield { kind: "done", finalText: stepText || lastText || "(doom loop)" };
        return;
      }

      yield { kind: "tool_start", callId: call.id, name: call.name, args: call.args };

      const result = await runOneTool(opts, call, askFn, policy);

      yield {
        kind: "tool_end",
        callId: call.id,
        name: call.name,
        output: result.output,
        isError: result.isError === true,
      };

      toolResultParts.push({
        type: "tool_result",
        callId: call.id,
        output: result.output,
        isError: result.isError,
      });
    }

    // observe：本步所有工具结果合并回填为单条 user 消息。
    messages.push({ role: "user", content: toolResultParts });
  }

  // 步数上限：硬收尾。
  yield { kind: "done", finalText: lastText || "(step limit reached)" };
}

/**
 * 执行单个工具调用：解析工具、跑策略、执行。
 * 所有失败路径均返回结构化 { output, isError:true }，绝不 throw 到循环外。
 */
async function runOneTool(
  opts: RunAgentLoopOptions,
  call: PendingCall,
  askFn: ToolContext["ask"],
  policy: PolicyConfig,
): Promise<ToolResultData> {
  const tool = opts.registry.get(call.name);
  if (!tool) {
    return { output: `未知工具: ${call.name}`, isError: true };
  }

  // L5 策略评估：reject 直接硬拒绝；ask 经 ctx.ask 走审批接缝；auto 放行。
  const decision = assess({ tool, args: call.args }, policy);
  if (decision === "reject") {
    return { output: `策略拒绝执行工具: ${call.name}`, isError: true };
  }
  if (decision !== "auto") {
    const verdict = await askFn({ tool: call.name, args: call.args });
    if (!verdict.approved) {
      return {
        output: `用户拒绝执行工具 ${call.name}${verdict.reason ? `：${verdict.reason}` : ""}`,
        isError: true,
      };
    }
  }

  const ctx: ToolContext = {
    sessionId: opts.sessionId,
    cwd: opts.cwd,
    signal: opts.signal,
    ask: askFn,
    depth: opts.depth,
    dispatch: opts.dispatch,
  };

  try {
    return await tool.execute(call.args, ctx);
  } catch (err) {
    // 工具契约要求结构化返回；此处仅作防御，把意外异常也转成结构化错误。
    const message = err instanceof Error ? err.message : String(err);
    return { output: `工具执行异常: ${message}`, isError: true };
  }
}

/** 安全序列化 args，用于 doom-loop key（不可序列化时退化为 String）。 */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch {
    return String(value);
  }
}
