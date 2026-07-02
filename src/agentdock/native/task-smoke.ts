// L6 子 agent（task 工具）冒烟测试（无网络）。
//
// 场景 A：主 loop 用 mock 模型调 task 工具（缺省 runner）-> 注入的假 dispatch 回吐一段预设
//         AgentEvent 流 -> 断言 tool_result 含子 agent 最终文本，且 dispatch 收到 ref=null、depth=1。
// 场景 B：显式 runner="cli:codex" -> 断言 dispatch 收到的 ref 被正确解码为 {kind:"cli",agent:"codex"}。
// 场景 C：深度守卫 —— ctx.depth=MAX_DISPATCH_DEPTH 时直接调 tool.execute，断言结构化错误且 dispatch 未被调用。
// 场景 D：非法 runner id -> 结构化错误（不 throw）。
// 场景 E：未注入 dispatch -> 结构化错误（不 throw）。
// 场景 F：子 agent「产出部分文本后又报错」（driver flush-before-error 语序）-> task 必须按失败
//         上报（isError:true）且不把残缺文本当完整答案，同时把报错与部分文本一并附回。
// 全程用 MockModelClient / 假 dispatch 驱动真实 runAgentLoop + 真实 task 工具，无网络。

import { runAgentLoop } from "./loop.js";
import type { ModelClient, ModelStreamRequest } from "./model.js";
import type { DispatchFn, ToolContext } from "./tool.js";
import { ToolRegistry } from "./tool.js";
import { createTaskTool, MAX_DISPATCH_DEPTH } from "./tools/task.js";
import type { AgentEvent, RunnerRef } from "../runtime/types.js";
import type { LoopEvent, ResponseEvent } from "./types.js";

/** 子 agent 最终文本特征串。 */
const CHILD_FINAL = "子 agent 完成：6 * 7 = 42";

/** 记录 dispatch 被调用时收到的参数，供断言。 */
type DispatchCall = { ref: RunnerRef | null; prompt: string; depth: number; description?: string };

/** 构造一个假 dispatch：记录入参，并回吐 lifecycle -> tool -> message(final) 三段预设事件。 */
function makeFakeDispatch(record: DispatchCall[]): DispatchFn {
  return async function* (ref, prompt, opts): AsyncGenerator<AgentEvent> {
    record.push({ ref, prompt, depth: opts.depth, description: opts.description });
    yield fakeEvent("lifecycle", "子 agent 开始", "启动", "started");
    yield fakeEvent("tool", "调用工具 bash", "echo hi", "completed");
    // 子 agent 的最终助手文本（= 最后一条 message 事件）。
    yield fakeEvent("message", "回复", CHILD_FINAL, "completed");
  };
}

/** 造一个最小 AgentEvent。 */
function fakeEvent(
  kind: AgentEvent["kind"],
  title: string,
  body: string,
  status: AgentEvent["status"],
): AgentEvent {
  return {
    id: `evt_${Math.random().toString(36).slice(2, 10)}`,
    sessionId: "child-smoke",
    kind,
    title,
    body,
    status,
    createdAt: new Date().toISOString(),
  };
}

/** 主 agent mock 模型：第 1 次请求发一个 task 工具调用，第 2 次输出收尾文本。 */
class TaskCallingMock implements ModelClient {
  private n = 0;
  constructor(private readonly taskArgs: Record<string, unknown>) {}

  async *stream(_req: ModelStreamRequest): AsyncGenerator<ResponseEvent> {
    this.n += 1;
    if (this.n === 1) {
      yield { kind: "tool_call", call: { id: "t1", name: "task", args: this.taskArgs } };
      yield { kind: "completed" };
      return;
    }
    yield { kind: "text_delta", text: "主 agent 收尾。" };
    yield { kind: "completed" };
  }
}

/** 用真实 loop 跑一遍：registry 只挂 task 工具，注入 depth + fakeDispatch。 */
async function drainLoop(model: ModelClient, dispatch: DispatchFn, depth: number): Promise<LoopEvent[]> {
  const registry = new ToolRegistry();
  registry.register(createTaskTool());
  const events: LoopEvent[] = [];
  const loop = runAgentLoop({
    model,
    registry,
    system: "冒烟测试系统提示。",
    messages: [{ role: "user", content: [{ type: "text", text: "把子任务外包出去。" }] }],
    modelId: "mock-model",
    cwd: process.cwd(),
    sessionId: "task-smoke-session",
    depth,
    dispatch,
  });
  for await (const ev of loop) {
    events.push(ev);
  }
  return events;
}

/** 构造一个 headless ToolContext，用于直接调 tool.execute（审批自动放行）。 */
function makeCtx(over: Partial<ToolContext>): ToolContext {
  return {
    sessionId: "task-smoke",
    cwd: process.cwd(),
    ask: async () => ({ approved: true }),
    ...over,
  };
}

/** 场景 A：缺省 runner，经真实 loop，tool_result 含子 agent 最终文本，dispatch 收到 ref=null、depth=1。 */
async function checkDefaultRunner(failures: string[]): Promise<void> {
  const record: DispatchCall[] = [];
  const events = await drainLoop(
    new TaskCallingMock({ prompt: "算 6*7", description: "算术" }),
    makeFakeDispatch(record),
    0,
  );

  const taskEnd = events.find(
    (ev): ev is Extract<LoopEvent, { kind: "tool_end" }> => ev.kind === "tool_end" && ev.name === "task",
  );
  if (!taskEnd || taskEnd.isError || !taskEnd.output.includes(CHILD_FINAL)) {
    failures.push(`[A] task tool_end 断言失败：${JSON.stringify(taskEnd)}`);
  }
  if (record.length !== 1) {
    failures.push(`[A] 期望 dispatch 被调用 1 次，实际 ${record.length}`);
  } else {
    const call = record[0]!;
    if (call.ref !== null) {
      failures.push(`[A] 缺省 runner 应把 ref 传为 null，实际 ${JSON.stringify(call.ref)}`);
    }
    if (call.depth !== 1) {
      failures.push(`[A] 子 agent depth 应为 1（父 depth 0 + 1），实际 ${call.depth}`);
    }
    if (call.prompt !== "算 6*7") {
      failures.push(`[A] dispatch 收到的 prompt 不符：${call.prompt}`);
    }
  }
  const done = events.find((ev): ev is Extract<LoopEvent, { kind: "done" }> => ev.kind === "done");
  if (!done || !done.finalText.includes("主 agent 收尾")) {
    failures.push(`[A] 主 agent 收尾文本断言失败：${JSON.stringify(done)}`);
  }
}

/** 场景 B：显式 runner="cli:codex"，dispatch 应收到解码后的 {kind:"cli",agent:"codex"}。 */
async function checkExplicitRunner(failures: string[]): Promise<void> {
  const record: DispatchCall[] = [];
  await drainLoop(
    new TaskCallingMock({ prompt: "用 codex 跑", runner: "cli:codex" }),
    makeFakeDispatch(record),
    0,
  );
  const ref = record[0]?.ref;
  if (!ref || ref.kind !== "cli" || ref.agent !== "codex") {
    failures.push(`[B] 显式 runner 未被解码为 cli:codex：${JSON.stringify(ref)}`);
  }
}

/** 场景 C：深度守卫 —— depth 已达上限时拒绝，且不调用 dispatch。 */
async function checkDepthGuard(failures: string[]): Promise<void> {
  const record: DispatchCall[] = [];
  const tool = createTaskTool();
  const res = await tool.execute(
    { prompt: "还想再委派" },
    makeCtx({ depth: MAX_DISPATCH_DEPTH, dispatch: makeFakeDispatch(record) }),
  );
  if (!res.isError) {
    failures.push(`[C] 深度封顶时应返回 isError:true，实际：${JSON.stringify(res)}`);
  }
  if (!res.output.includes(String(MAX_DISPATCH_DEPTH))) {
    failures.push(`[C] 深度封顶错误信息应含上限 ${MAX_DISPATCH_DEPTH}：${res.output}`);
  }
  if (record.length !== 0) {
    failures.push(`[C] 深度封顶时不应调用 dispatch，实际调用 ${record.length} 次`);
  }
}

/** 场景 D：非法 runner id -> 结构化错误。 */
async function checkBadRunner(failures: string[]): Promise<void> {
  const record: DispatchCall[] = [];
  const tool = createTaskTool();
  const res = await tool.execute(
    { prompt: "任务", runner: "not-a-valid-runner" },
    makeCtx({ depth: 0, dispatch: makeFakeDispatch(record) }),
  );
  if (!res.isError) {
    failures.push(`[D] 非法 runner 应返回 isError:true，实际：${JSON.stringify(res)}`);
  }
  if (record.length !== 0) {
    failures.push(`[D] 非法 runner 时不应调用 dispatch，实际调用 ${record.length} 次`);
  }
}

/** 场景 E：未注入 dispatch -> 结构化错误。 */
async function checkNoDispatch(failures: string[]): Promise<void> {
  const tool = createTaskTool();
  const res = await tool.execute({ prompt: "任务" }, makeCtx({ depth: 0 }));
  if (!res.isError || !res.output.includes("dispatch")) {
    failures.push(`[E] 未注入 dispatch 应返回结构化错误，实际：${JSON.stringify(res)}`);
  }
}

/**
 * 场景 F：子 agent 先吐部分文本（message）再报错（error）——精确复刻 driver 的 flush-before-error
 * 语序。task 必须以失败结果回传（isError:true），且不得把残缺文本当成功答案；输出里应同时含报错
 * 与已产出的部分文本，便于父 agent 追溯。
 */
async function checkPartialThenError(failures: string[]): Promise<void> {
  const partial = "部分答案：我正在计算…";
  const errMsg = "Anthropic 529 overloaded（流中断）";
  const tool = createTaskTool();
  // 假 dispatch：先 message（部分文本）后 error，与 NativeAgentDriver 出错时的事件顺序一致。
  const dispatch: DispatchFn = async function* () {
    yield fakeEvent("message", "回复", partial, "completed");
    yield fakeEvent("error", "原生 Agent 错误", errMsg, "failed");
  };
  const res = await tool.execute({ prompt: "算个东西" }, makeCtx({ depth: 0, dispatch }));
  if (res.isError !== true) {
    failures.push(`[F] 子 agent 报错时 task 应返回 isError:true，实际：${JSON.stringify(res)}`);
  }
  if (!res.output.includes(errMsg)) {
    failures.push(`[F] task 输出应含子 agent 报错信息「${errMsg}」，实际：${res.output}`);
  }
  if (!res.output.includes(partial)) {
    failures.push(`[F] task 输出应附回已产出的部分文本，实际：${res.output}`);
  }
}

async function main(): Promise<void> {
  const failures: string[] = [];
  await checkDefaultRunner(failures);
  await checkExplicitRunner(failures);
  await checkDepthGuard(failures);
  await checkBadRunner(failures);
  await checkNoDispatch(failures);
  await checkPartialThenError(failures);

  if (failures.length === 0) {
    console.log(
      "PASS: L6 子 agent 冒烟测试通过（缺省/显式 runner 派发 + 抽取子 agent 最终文本 + 深度守卫 + 非法 runner + 缺 dispatch 结构化错误 + 部分文本后报错按失败上报）。",
    );
    process.exitCode = 0;
  } else {
    console.log("FAIL: L6 子 agent 冒烟测试未通过。");
    for (const f of failures) {
      console.log(`  - ${f}`);
    }
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.log("FAIL: 冒烟测试抛出异常。");
  console.log(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
