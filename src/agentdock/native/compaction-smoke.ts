// L4 上下文压缩冒烟测试（无网络）。
//
// 场景 A：超大 tool_result 被裁剪，含省略标记，且保留头+尾。
// 场景 B：超预算时最旧前缀折叠为一条摘要消息，且结果中无 orphan tool_call/tool_result
//         （每个 tool_use id 都有配对 tool_result，反之亦然）。
// 场景 C：最近若干条消息逐字保留（未被折叠、未被改写）。
// 全程用纯函数 compact / truncateToolOutputs / estimateTokens，无网络。

import { compact, estimateTokens, truncateToolOutputs } from "./compaction.js";
import type { Message } from "./types.js";

/** 构造一段「多轮工具调用」会话：user 起头，随后 assistant(tool_call)+user(tool_result) 交替。 */
function buildConversation(rounds: number, resultChars: number): Message[] {
  const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "开始任务：请逐步排查代码。" }] }];
  for (let i = 0; i < rounds; i += 1) {
    const callId = `call-${i}`;
    const toolName = i % 2 === 0 ? "read" : "bash";
    messages.push({
      role: "assistant",
      content: [
        { type: "text", text: `第 ${i} 轮：我先看看情况。` },
        { type: "tool_call", id: callId, name: toolName, args: { n: i } },
      ],
    });
    messages.push({
      role: "user",
      content: [{ type: "tool_result", callId, output: `第${i}轮结果 `.repeat(Math.ceil(resultChars / 6)) }],
    });
  }
  return messages;
}

/** 收集视图里所有 tool_call id 与 tool_result callId。 */
function collectToolIds(messages: Message[]): { calls: string[]; results: string[] } {
  const calls: string[] = [];
  const results: string[] = [];
  for (const m of messages) {
    for (const p of m.content) {
      if (p.type === "tool_call") {
        calls.push(p.id);
      } else if (p.type === "tool_result") {
        results.push(p.callId);
      }
    }
  }
  return { calls, results };
}

/** 场景 A：超大 tool_result 被裁剪且含省略标记，保留头+尾。 */
function checkTruncate(failures: string[]): void {
  const head = "HEAD_START_MARKER";
  const tail = "TAIL_END_MARKER";
  const bigOutput = `${head}${"x".repeat(50_000)}${tail}`;
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: "跑" }] },
    {
      role: "assistant",
      content: [{ type: "tool_call", id: "c1", name: "bash", args: {} }],
    },
    { role: "user", content: [{ type: "tool_result", callId: "c1", output: bigOutput }] },
  ];

  const view = truncateToolOutputs(messages, 8000);
  const tr = view[2].content[0];
  if (!tr || tr.type !== "tool_result") {
    failures.push("[A] 未找到裁剪后的 tool_result");
    return;
  }
  if (tr.output.length >= bigOutput.length) {
    failures.push(`[A] tool_result 未变短：${tr.output.length} >= ${bigOutput.length}`);
  }
  if (!tr.output.includes("[已省略") || !tr.output.includes("字符]")) {
    failures.push(`[A] 缺少省略标记：${tr.output.slice(0, 80)}…`);
  }
  if (!tr.output.startsWith(head)) {
    failures.push("[A] 未保留头部");
  }
  if (!tr.output.endsWith(tail)) {
    failures.push("[A] 未保留尾部");
  }

  // 非破坏：原始消息未被改动。
  const original = messages[2].content[0];
  if (original.type === "tool_result" && original.output.length !== bigOutput.length) {
    failures.push("[A] 原始 messages 被破坏性修改");
  }
}

/** 场景 B + C：超预算折叠为摘要、无 orphan、最近若干条逐字保留。 */
function checkCompact(failures: string[]): void {
  const rounds = 8;
  const keepRecent = 4;
  const messages = buildConversation(rounds, 300);

  // 预算压到远小于全量，强制触发折叠（用 maxContextTokens 覆盖，绕过大兜底）。
  const view = compact(messages, { maxContextTokens: 200, keepRecent, maxToolChars: 8000 });

  // (B1) 首条应为折叠摘要（user 文本，含标记）。
  const first = view[0];
  const firstText = first && first.role === "user" && first.content[0]?.type === "text" ? first.content[0].text : null;
  if (!firstText || !firstText.includes("[前文摘要]")) {
    failures.push(`[B] 首条不是折叠摘要：${JSON.stringify(first).slice(0, 120)}`);
  }
  // 折叠确有发生：视图应短于原始消息数。
  if (view.length >= messages.length) {
    failures.push(`[B] 未发生折叠：view=${view.length} original=${messages.length}`);
  }

  // (B2) 无 orphan：tool_call id 集合与 tool_result callId 集合必须一一配对（双向覆盖）。
  const { calls, results } = collectToolIds(view);
  const callSet = new Set(calls);
  const resultSet = new Set(results);
  for (const id of callSet) {
    if (!resultSet.has(id)) {
      failures.push(`[B] orphan tool_call（无配对 tool_result）：${id}`);
    }
  }
  for (const id of resultSet) {
    if (!callSet.has(id)) {
      failures.push(`[B] orphan tool_result（无配对 tool_call）：${id}`);
    }
  }
  if (calls.length !== callSet.size) {
    failures.push("[B] 出现重复 tool_call id");
  }

  // (B3) 角色交替：视图内不得出现连续同 role。
  for (let i = 1; i < view.length; i += 1) {
    if (view[i].role === view[i - 1].role) {
      failures.push(`[B] 出现连续同 role（index ${i - 1}/${i} 均为 ${view[i].role}）`);
      break;
    }
  }

  // (C) 最近 keepRecent 条逐字保留：视图尾部应与原始尾部逐字节相等。
  const tailView = view.slice(view.length - keepRecent);
  const tailOrig = messages.slice(messages.length - keepRecent);
  if (serialize(tailView) !== serialize(tailOrig)) {
    failures.push("[C] 最近若干条消息未逐字保留");
  }

  // (附加) 未超预算时 compact 应为无损裁剪视图（这里给一个绝对够大的预算）。
  const small = buildConversation(2, 50);
  const passthrough = compact(small, { maxContextTokens: 1_000_000 });
  if (serialize(passthrough) !== serialize(truncateToolOutputs(small, 8000))) {
    failures.push("[附加] 未超预算时 compact 非无损透传");
  }
  if (estimateTokens(small) <= 0) {
    failures.push("[附加] estimateTokens 返回非正数");
  }
}

/** 稳定序列化（比较结构相等）。 */
function serialize(messages: Message[]): string {
  return JSON.stringify(messages);
}

function main(): void {
  const failures: string[] = [];
  checkTruncate(failures);
  checkCompact(failures);

  if (failures.length === 0) {
    console.log("PASS: L4 上下文压缩冒烟测试通过（超大结果裁剪 + 最旧前缀折叠 + 无 orphan + 最近逐字保留）。");
    process.exitCode = 0;
  } else {
    console.log("FAIL: L4 上下文压缩冒烟测试未通过。");
    for (const f of failures) {
      console.log(`  - ${f}`);
    }
    process.exitCode = 1;
  }
}

main();
