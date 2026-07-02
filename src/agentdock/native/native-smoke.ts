// 原生 Agent 冒烟测试（无网络）。
//
// 场景 A：单个 bash 工具调用（echo hello-agentdock）-> 收尾文本 "all done"。
// 场景 B：一步内两个 bash 工具调用（parallel tool use），验证两条 tool_result
//         被合并进「单条 user 消息」回填给模型（否则真实 Anthropic 会 400）。
// 全程用 MockModelClient 驱动真实 runAgentLoop + 真实内置工具，无网络。

import { runAgentLoop } from "./loop.js";
import type { ModelClient, ModelStreamRequest } from "./model.js";
import { ToolRegistry } from "./tool.js";
import { registerBuiltins } from "./tools/index.js";
import type { LoopEvent, Message, ResponseEvent } from "./types.js";

/** 场景 A：先发一个 bash 工具调用，再输出收尾文本。 */
class SingleToolMock implements ModelClient {
  private callCount = 0;

  async *stream(_req: ModelStreamRequest): AsyncGenerator<ResponseEvent> {
    this.callCount += 1;
    if (this.callCount === 1) {
      yield {
        kind: "tool_call",
        call: { id: "c1", name: "bash", args: { command: "echo hello-agentdock" } },
      };
      yield { kind: "completed" };
      return;
    }
    yield { kind: "text_delta", text: "all done" };
    yield { kind: "completed" };
  }
}

/** 场景 B：一步内发两个 bash 调用，并记录第 2 次请求时模型看到的消息。 */
class ParallelToolMock implements ModelClient {
  private callCount = 0;
  secondCallMessages: Message[] | null = null;

  async *stream(req: ModelStreamRequest): AsyncGenerator<ResponseEvent> {
    this.callCount += 1;
    if (this.callCount === 1) {
      yield { kind: "tool_call", call: { id: "a", name: "bash", args: { command: "echo AAA" } } };
      yield { kind: "tool_call", call: { id: "b", name: "bash", args: { command: "echo BBB" } } };
      yield { kind: "completed" };
      return;
    }
    // 记录观察阶段模型收到的消息（快照，避免 loop 后续 push 污染引用）。
    this.secondCallMessages = req.messages.map((m) => ({ role: m.role, content: [...m.content] }));
    yield { kind: "text_delta", text: "parallel done" };
    yield { kind: "completed" };
  }
}

async function drain(model: ModelClient): Promise<LoopEvent[]> {
  const registry = new ToolRegistry();
  registerBuiltins(registry, { cwd: process.cwd() });
  const events: LoopEvent[] = [];
  const loop = runAgentLoop({
    model,
    registry,
    system: "冒烟测试系统提示。",
    messages: [{ role: "user", content: [{ type: "text", text: "跑一下工具。" }] }],
    modelId: "mock-model",
    cwd: process.cwd(),
    sessionId: "smoke-session",
  });
  for await (const ev of loop) {
    events.push(ev);
  }
  return events;
}

/** 场景 A 断言。 */
async function checkSingle(failures: string[]): Promise<void> {
  const events = await drain(new SingleToolMock());
  const bashEnd = events.find(
    (ev): ev is Extract<LoopEvent, { kind: "tool_end" }> => ev.kind === "tool_end" && ev.name === "bash",
  );
  const done = events.find((ev): ev is Extract<LoopEvent, { kind: "done" }> => ev.kind === "done");
  if (!bashEnd || bashEnd.isError || !bashEnd.output.includes("hello-agentdock")) {
    failures.push(`[A] bash tool_end 断言失败：${JSON.stringify(bashEnd)}`);
  }
  if (!done || !done.finalText.includes("all done")) {
    failures.push(`[A] done.finalText 断言失败：${JSON.stringify(done)}`);
  }
}

/** 场景 B 断言：两工具结果合并成单条 user 消息，且无连续同 role。 */
async function checkParallel(failures: string[]): Promise<void> {
  const mock = new ParallelToolMock();
  const events = await drain(mock);

  const toolEnds = events.filter((ev): ev is Extract<LoopEvent, { kind: "tool_end" }> => ev.kind === "tool_end");
  if (toolEnds.length !== 2) {
    failures.push(`[B] 期望 2 个 tool_end，实际 ${toolEnds.length}`);
  }

  const seen = mock.secondCallMessages;
  if (!seen) {
    failures.push("[B] 第 2 次请求未捕获到消息");
    return;
  }
  // 无连续同 role。
  for (let i = 1; i < seen.length; i += 1) {
    if (seen[i]!.role === seen[i - 1]!.role) {
      failures.push(`[B] 出现连续同 role 消息（index ${i - 1}/${i} 均为 ${seen[i]!.role}）`);
      break;
    }
  }
  // 末条应为单条 user 消息，含 2 个 tool_result。
  const last = seen[seen.length - 1];
  const toolResults = last ? last.content.filter((p) => p.type === "tool_result") : [];
  if (!last || last.role !== "user" || toolResults.length !== 2) {
    failures.push(`[B] 末条 user 消息未合并两条 tool_result：${JSON.stringify(last)}`);
  }
}

async function main(): Promise<void> {
  const failures: string[] = [];
  await checkSingle(failures);
  await checkParallel(failures);

  if (failures.length === 0) {
    console.log("PASS: 原生 Agent 冒烟测试通过（单工具循环 + 收尾文本 + 并行工具结果合并）。");
    process.exitCode = 0;
  } else {
    console.log("FAIL: 原生 Agent 冒烟测试未通过。");
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
