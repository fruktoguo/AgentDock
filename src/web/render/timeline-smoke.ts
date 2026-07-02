// 编排看板前端冒烟测试（落地第 5 步 · 前端验收）。
//
// node 直跑（不 import app.js 或任何触碰 document/window 的模块）：
//   被测的是纯渲染函数 —— orchestration.ts（看板纯函数）与 timeline.ts（组装 + details 过滤），
//   二者的 import 链只有 icons/utils/state/types，均为纯模块，故可在 node 下加载。
//
// 覆盖（对应 docs/orchestration-protocol.md §4 前端消费）：
//   1. 含结构化事件的假 session → 渲出各状态卡片（pending/running/retrying/completed/failed/skipped）
//      与依赖标签「← s1」；同一 stepId 取「最新」一条 step 事件（running→completed 后为 completed）。
//   2. 两种结构化事件（orchestrator.plan / orchestrator.step）不进 group details（无 JSON 噪音），
//      人读 dispatch 与子任务底层事件照旧进 details。
//   3. 计划事件 body JSON 损坏 → 回退纯文本 <pre>，不报错、不空白、不出看板。
//   4. 旧会话（无结构化事件）走现状渲染路径、不出看板（向后兼容）。
//
// 末行打印「PASS: ...」；任一断言失败即抛错。

import type { AgentEvent, AgentMessage, AgentSession } from "../types.js";
import { isStructuredOrchestrationEvent, renderOrchestrationBoard } from "./orchestration.js";
import { renderTimeline } from "./timeline.js";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`断言失败：${message}`);
  }
}

/** 从渲染结果里切出某个步骤卡片的 HTML 片段（按 <article> 边界定位含该 orch-step-id 的那段）。 */
function cardFor(html: string, stepId: string): string {
  const marker = `class="orch-step-id">${stepId}<`;
  return html.split("<article").find((part) => part.includes(marker)) ?? "";
}

const BASE = Date.parse("2026-07-01T00:00:00.000Z");
let seq = 0;

/** 造一条 AgentEvent；createdAt 随创建序单调递增，保证「最新一条」= 最后创建的一条。 */
function ev(partial: Partial<AgentEvent> & { kind: AgentEvent["kind"] }): AgentEvent {
  seq += 1;
  return {
    id: `evt-${seq}`,
    sessionId: "sess-1",
    kind: partial.kind,
    title: partial.title ?? "",
    body: partial.body ?? "",
    status: partial.status,
    rawType: partial.rawType,
    source: partial.source,
    group: partial.group,
    createdAt: partial.createdAt ?? new Date(BASE + seq * 1000).toISOString(),
  };
}

function userMessage(): AgentMessage {
  return { id: "msg-user", role: "user", content: "请编排一个多步任务", createdAt: new Date(BASE).toISOString() };
}

function makeSession(events: AgentEvent[]): AgentSession {
  return {
    id: "sess-1",
    title: "编排会话",
    agent: "codex",
    model: null,
    runnerId: "orch",
    status: "running",
    createdAt: new Date(BASE).toISOString(),
    updatedAt: new Date(BASE).toISOString(),
    codexThreadId: null,
    claudeSessionId: null,
    messages: [userMessage()],
    events,
  };
}

function stepEvent(data: Record<string, unknown>, status: AgentEvent["status"]): AgentEvent {
  return ev({
    kind: "dispatch",
    rawType: "orchestrator.step",
    group: `step-${String(data.stepId)}`,
    source: "编排 Agent",
    title: "步骤状态",
    status,
    body: JSON.stringify(data),
  });
}

// —— 1. 主看板：结构化事件齐全 ——
function checkFullBoard(): void {
  const planBody = JSON.stringify({
    version: 1,
    task: "多步任务",
    steps: [
      { id: "s1", title: "调研", runnerId: "cli:codex", runnerLabel: "Codex CLI", dependsOn: [] },
      { id: "s2", title: "编码", runnerId: "cli:claude", runnerLabel: "Claude Code", dependsOn: ["s1"] },
      { id: "s3", title: "测试", runnerId: "cli:claude", runnerLabel: "Claude Code", dependsOn: ["s1"] },
      { id: "s4", title: "部署", runnerId: "cli:codex", runnerLabel: "Codex CLI", dependsOn: ["s2"] },
      { id: "s5", title: "回滚", runnerId: "cli:codex", runnerLabel: "Codex CLI", dependsOn: ["s4"] },
      { id: "s6", title: "收尾", runnerId: "cli:codex", runnerLabel: "Codex CLI", dependsOn: [] },
    ],
  });

  const events: AgentEvent[] = [
    ev({ kind: "plan", rawType: "orchestrator.plan", group: "plan", status: "completed", title: "规划完成", body: planBody }),

    // s1：running → completed（验证「最新一条」取 completed）。s1 是唯一 completed 步。
    stepEvent({ stepId: "s1", state: "running", attempt: 1, runnerLabel: "Codex CLI", title: "调研" }, "started"),
    // s1 组底层事件（应进 details，且被计数 / 汇总 token）。
    ev({ kind: "dispatch", group: "step-s1", source: "编排 Agent", title: "派发给 Codex CLI", body: "HUMAN_DISPATCH_MARKER 请调研 X 的可行性" }),
    ev({ kind: "tool", group: "step-s1", source: "Codex CLI", title: "TOOL_MARKER 执行 grep", body: "grep -r foo" }),
    ev({ kind: "usage", group: "step-s1", source: "Codex CLI", title: "用量", body: JSON.stringify({ input_tokens: 100, output_tokens: 50 }) }),
    stepEvent({ stepId: "s1", state: "completed", attempt: 1, runnerLabel: "Codex CLI", title: "调研" }, "completed"),

    stepEvent({ stepId: "s2", state: "running", attempt: 1, runnerLabel: "Claude Code", title: "编码" }, "started"),
    stepEvent({ stepId: "s3", state: "retrying", attempt: 2, runnerLabel: "Gemini 原生", title: "测试", detail: "首次失败，改用「Gemini 原生」重试" }, "updated"),
    stepEvent({ stepId: "s4", state: "failed", attempt: 2, runnerLabel: "Codex CLI", title: "部署", detail: "尝试次数耗尽" }, "failed"),
    stepEvent({ stepId: "s5", state: "skipped", attempt: 1, runnerLabel: "Codex CLI", title: "回滚", detail: "因 s4 失败跳过" }, "failed"),
    // s6：无 step 事件 → pending。
  ];

  const html = renderTimeline(makeSession(events));

  // 看板存在且仅一份。
  assert(html.includes('class="orch-board"'), "应渲染编排看板 orch-board");
  assert(html.split('class="orch-board"').length - 1 === 1, "看板应只渲染一份，不重复");

  // 六种状态卡片齐全。
  assert(html.includes("orch-step--completed"), "s1 应为 completed（最新一条 step 事件覆盖 running）");
  assert(html.includes("orch-step--running"), "s2 应为 running");
  assert(html.includes("orch-step--retrying"), "s3 应为 retrying");
  assert(html.includes("orch-step--failed"), "s4 应为 failed");
  assert(html.includes("orch-step--skipped"), "s5 应为 skipped");
  assert(html.includes("orch-step--pending"), "s6 无 step 事件应为 pending");

  // 状态文案。
  assert(html.includes("已完成") && html.includes("重试中") && html.includes("已跳过"), "应含状态中文文案");

  // 依赖标签「← s1」/「← s4」。
  assert(html.includes("← s1"), "应渲染依赖标签 ← s1");
  assert(html.includes("← s4"), "应渲染依赖标签 ← s4");

  // attempt>1 标注重试 + 换人：在 s3 卡片作用域内断言，证明展示的是「换后」执行体，
  // 而非任意位置的同名串（s3 计划步 runnerLabel 原为 Claude Code，被 step 事件的换后 runner 覆盖）。
  const s3card = cardFor(html, "s3");
  assert(s3card !== "", "应能定位到 s3 卡片");
  assert(s3card.includes("↻ 第 2 次"), "s3 卡片应标注「↻ 第 2 次」");
  assert(s3card.includes("Gemini 原生"), "s3 卡片应展示换后的执行体 runnerLabel（Gemini 原生）");
  assert(
    !s3card.includes("Codex CLI") && !s3card.includes("Claude Code"),
    "s3 卡片当前 runner 应是换后执行体，不应残留首跑失败者/其它步骤的执行体名",
  );
  assert(s3card.includes("重试"), "s3 卡片应渲染换人说明 detail");

  // 底层事件计数 + token 用量出现在卡片上。
  assert(html.includes("输入 100"), "s1 卡片应汇总 token 用量（输入 100）");

  // 结构化事件不进 details：其 rawType / JSON 键均不应出现在渲染结果。
  assert(!html.includes("orchestrator.step"), "orchestrator.step 不应出现在 details");
  assert(!html.includes("orchestrator.plan"), "orchestrator.plan 不应出现在 details");
  assert(!html.includes("stepId"), "step 事件 JSON（stepId）不应泄漏进 details");

  // 人读 dispatch 与子任务底层事件照旧进 details。
  assert(html.includes("HUMAN_DISPATCH_MARKER"), "人读 dispatch（instruction）应进 details");
  assert(html.includes("TOOL_MARKER"), "子任务底层事件应进 details");

  // 卡片与对应 step details 已连线（走事件委托，无内联 onclick）。
  assert(html.includes('data-action="toggle-step"'), "可点开的卡片应带 data-action=toggle-step");
  assert(html.includes('data-details-target="sub:step-s1"'), "卡片应指向 sub:step-s1");
  assert(html.includes('data-details-key="sub:step-s1"'), "应存在 sub:step-s1 的 details");
  assert(!html.includes("onclick"), "不得引入内联 onclick");
}

// —— 2. 计划 JSON 损坏 → 回退 <pre>，不出看板 ——
function checkCorruptPlanFallback(): void {
  const events: AgentEvent[] = [
    ev({
      kind: "plan",
      rawType: "orchestrator.plan",
      group: "plan",
      status: "completed",
      title: "规划完成",
      body: '{"version":1,"steps": CORRUPT_MARKER 这不是合法 JSON',
    }),
  ];
  let html = "";
  // 不得抛错。
  html = renderTimeline(makeSession(events));
  assert(!html.includes("orch-board"), "JSON 损坏时不应出看板");
  assert(html.includes("plan-card"), "应回退为 plan-card");
  assert(html.includes("<pre>"), "应以纯文本 <pre> 展示原始 body");
  assert(html.includes("CORRUPT_MARKER"), "回退的 <pre> 应含原始 body 内容");

  // 纯函数层：损坏计划返回空串（不抛错）。
  assert(renderOrchestrationBoard(events) === "", "renderOrchestrationBoard 对损坏计划应返回空串");
}

// —— 3. 旧会话（无结构化事件）→ 现状渲染、不出看板 ——
function checkLegacyBackwardCompat(): void {
  const events: AgentEvent[] = [
    ev({ kind: "plan", group: "plan", status: "completed", title: "规划完成", body: "1. [Codex CLI] 调研\n2. [Claude Code] 编码" }),
    ev({ kind: "dispatch", group: "step-1", source: "编排 Agent", title: "派发给 Codex CLI", body: "调研\n\n请调研" }),
    ev({ kind: "tool", group: "step-1", source: "Codex CLI", title: "执行命令", body: "ls" }),
    ev({ kind: "usage", group: "step-1", source: "Codex CLI", title: "用量", body: JSON.stringify({ input_tokens: 10, output_tokens: 5 }) }),
  ];
  const html = renderTimeline(makeSession(events));
  assert(!html.includes("orch-board"), "旧会话不应出看板");
  assert(html.includes("plan-card"), "旧会话仍应渲染计划卡片（现状路径）");
  assert(html.includes("process-group"), "旧会话仍应渲染子任务分组（现状路径）");
  assert(html.length > 0, "旧会话渲染结果不应为空");
}

// —— 4. 纯函数细节：结构化事件判定 + 空输入 ——
function checkPureHelpers(): void {
  const stepEv = stepEvent({ stepId: "sX", state: "running", attempt: 1 }, "started");
  const planEv = ev({ kind: "plan", rawType: "orchestrator.plan", body: "{}" });
  const toolEv = ev({ kind: "tool", group: "step-sX", title: "工具", body: "x" });
  assert(isStructuredOrchestrationEvent(stepEv), "orchestrator.step 应判为结构化事件");
  assert(isStructuredOrchestrationEvent(planEv), "orchestrator.plan 应判为结构化事件");
  assert(!isStructuredOrchestrationEvent(toolEv), "普通工具事件不应判为结构化事件");
  assert(renderOrchestrationBoard([]) === "", "空事件应返回空串（不出看板）");
}

function main(): void {
  checkFullBoard();
  checkCorruptPlanFallback();
  checkLegacyBackwardCompat();
  checkPureHelpers();
  console.log("PASS: 编排看板前端冒烟测试通过（各状态卡片 + 依赖标签 + 最新态取值 + 结构化事件隔离 + JSON 损坏回退 <pre> + 旧会话无看板）。");
}

main();
