// 落地第 5 步 · 并行编排调度器冒烟测试（无网络，node 直跑）。
//
// 用 mock registry + 假 driver（脚本化事件 + setTimeout 人为延迟）覆盖契约 §5 后端用例：
//   1) 并行时序重叠：用时间戳证明两个无依赖步骤的执行窗口重叠。
//   2) 依赖上下文注入：下游步骤 content 含上游产出 + 来源标注；无依赖步骤不注入。
//   3) 重试换人：首跑失败（含部分产出）→ 换 brain 重试成功，部分产出被清空不入最终结果。
//   4) 依赖失败跳过：根步骤失败 → 直接/间接依赖沿链 skipped（不派发）。
//   5) 并发上限=1 退化串行：两个无依赖步骤执行窗口不重叠。
//   6) 事件完整性：每步都有 step 事件、plan JSON 可解析、最终 message 唯一且无 group。
//   7) abort 后不再派发：中止后未启动步骤 skipped「已中止」，不再派发。
//
// 全程假 driver 由 input.group 区分 规划 / 合成 / 步骤，由 input.content 承接上下文交接。
// 末行打印「PASS: …」；任一断言失败抛错并以非零码退出。

import { OrchestratorDriver } from "./agents/orchestrator.js";
import type { DriverRegistry } from "./driver-registry.js";
import type {
  AgentDriver,
  AgentEvent,
  AgentSession,
  Backend,
  RunTurnInput,
  RunnerOption,
  RunnerRef,
} from "./types.js";

// ---------------------------------------------------------------------------
// 假 driver / mock registry
// ---------------------------------------------------------------------------

type StepResult = "text" | "empty" | "throw";

type StepBehavior = {
  delayMs: number;
  result: StepResult;
  text?: string;
  errMsg?: string;
  /** 失败前先吐一段「部分产出」（completed message），用于验证重试时被清空。 */
  partialText?: string;
  /** 额外吐一条「带 source、无 group」的 completed message，用于验证回填不漏气泡（修复[1]）。 */
  extraSourced?: string;
  /** 延迟结束后、产出前触发的副作用（如中止）。 */
  onComplete?: () => void;
};

type RunRecord = { group: string; runner: string; content: string; start: number; end: number };

type MockConfig = {
  runners: { id: string; label: string; backend?: Backend }[];
  planJson: string;
  synthText?: string;
  behavior: (runnerId: string, input: RunTurnInput) => StepBehavior;
  runs: RunRecord[];
};

function rid(): string {
  return `evt_${Math.random().toString(36).slice(2, 10)}`;
}

function fakeMessage(text: string): AgentEvent {
  return {
    id: rid(),
    sessionId: "orch-smoke",
    kind: "message",
    title: "回复",
    body: text,
    status: "completed",
    createdAt: new Date().toISOString(),
  };
}

function fakeLifecycle(title: string): AgentEvent {
  return {
    id: rid(),
    sessionId: "orch-smoke",
    kind: "lifecycle",
    title,
    body: "",
    status: "started",
    createdAt: new Date().toISOString(),
  };
}

/** 可被 AbortSignal 取消的延迟。 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(new Error("aborted"));
    };
    function cleanup(): void {
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
    }
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/** 一个假 driver：由 input.group 区分 规划 / 合成 / 步骤。 */
function makeDriver(id: string, cfg: MockConfig): AgentDriver {
  return {
    async *runTurn(input: RunTurnInput): AsyncGenerator<AgentEvent> {
      const group = input.group ?? "";
      if (group === "plan") {
        yield fakeMessage(cfg.planJson);
        return;
      }
      if (group === "synthesis") {
        yield fakeMessage(cfg.synthText ?? "");
        return;
      }
      // 步骤执行：记录窗口 + content，模拟延迟，产出/失败
      const behavior = cfg.behavior(id, input);
      const start = Date.now();
      const record: RunRecord = { group, runner: id, content: input.content, start, end: start };
      cfg.runs.push(record);
      yield fakeLifecycle(`${id} 开始`);
      await sleep(behavior.delayMs, input.signal);
      record.end = Date.now();
      behavior.onComplete?.();
      if (behavior.partialText) {
        yield fakeMessage(behavior.partialText);
      }
      if (behavior.extraSourced) {
        // 带 source、无 group：模拟「只报来源名、不懂 group」的第三方可插拔 driver。
        yield {
          id: rid(),
          sessionId: "orch-smoke",
          kind: "message",
          title: "外部回复",
          body: behavior.extraSourced,
          status: "completed",
          source: "外部执行体",
          createdAt: new Date().toISOString(),
        };
      }
      if (behavior.result === "throw") {
        throw new Error(behavior.errMsg ?? "模拟执行失败");
      }
      if (behavior.result === "empty") {
        return;
      }
      yield fakeMessage(behavior.text ?? "");
    },
  };
}

function makeRegistry(cfg: MockConfig): DriverRegistry {
  const drivers = new Map<string, AgentDriver>();
  for (const runner of cfg.runners) {
    drivers.set(runner.id, makeDriver(runner.id, cfg));
  }
  const registry = {
    resolve(ref: RunnerRef): { driver?: AgentDriver; error?: string } {
      const runnerId = (ref as { agent?: string }).agent ?? "";
      const driver = drivers.get(runnerId);
      return driver ? { driver } : { error: `mock 无 driver：${runnerId}` };
    },
  };
  return registry as unknown as DriverRegistry;
}

function makeSession(): AgentSession {
  const now = new Date().toISOString();
  return {
    id: "orch-smoke-session",
    title: "冒烟会话",
    agent: "codex",
    model: null,
    runnerId: "orchestrator",
    status: "running",
    createdAt: now,
    updatedAt: now,
    codexThreadId: null,
    claudeSessionId: null,
    messages: [],
    events: [],
  };
}

type RunOptions = {
  task?: string;
  policy?: { maxConcurrency?: number; maxAttempts?: number };
  signal?: AbortSignal;
};

async function runOrchestration(cfg: MockConfig, opts: RunOptions = {}): Promise<AgentEvent[]> {
  const registry = makeRegistry(cfg);
  const listRunners = async (): Promise<RunnerOption[]> =>
    cfg.runners.map((runner) => ({
      id: runner.id,
      ref: { kind: "cli", agent: runner.id } as unknown as RunnerRef,
      backend: runner.backend ?? "cli",
      label: runner.label,
      group: "测试",
      available: true,
    }));
  const driver = new OrchestratorDriver(registry, listRunners, opts.policy);
  const input: RunTurnInput = {
    session: makeSession(),
    content: opts.task ?? "测试任务",
    runner: { kind: "orchestrator" },
    signal: opts.signal,
  };
  const events: AgentEvent[] = [];
  for await (const event of driver.runTurn(input)) {
    events.push(event);
  }
  return events;
}

// ---------------------------------------------------------------------------
// 断言辅助
// ---------------------------------------------------------------------------

type StepEvent = { ev: AgentEvent; body: StepBody };
type StepBody = {
  stepId: string;
  state: string;
  attempt: number;
  runnerId: string;
  runnerLabel: string;
  title: string;
  detail?: string;
};

function stepEvents(events: AgentEvent[]): StepEvent[] {
  return events
    .filter((event) => event.rawType === "orchestrator.step")
    .map((event) => ({ ev: event, body: JSON.parse(event.body) as StepBody }));
}

function runFor(cfg: MockConfig, group: string): RunRecord | undefined {
  return cfg.runs.find((record) => record.group === group);
}

function assert(failures: string[], tag: string, cond: boolean, detail: string): void {
  if (!cond) {
    failures.push(`[${tag}] ${detail}`);
  }
}

function planStep(
  id: string,
  runnerId: string,
  title: string,
  instruction: string,
  dependsOn: string[] = [],
): Record<string, unknown> {
  return { id, title, runnerId, instruction, dependsOn };
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

/** 1) 并行时序重叠 + 6) 事件完整性（同一次运行一并断言）。 */
async function checkOverlapAndIntegrity(failures: string[]): Promise<void> {
  const cfg: MockConfig = {
    runners: [
      { id: "brain", label: "主脑" },
      { id: "a", label: "抓取器" },
      { id: "b", label: "翻译器" },
    ],
    planJson: JSON.stringify([
      planStep("s1", "a", "抓取", "抓取网页内容"),
      planStep("s2", "b", "翻译", "翻译一段文本"),
    ]),
    synthText: "SYNTH_FINAL",
    behavior: (runnerId) => ({ delayMs: 60, result: "text", text: `${runnerId}-done` }),
    runs: [],
  };
  const events = await runOrchestration(cfg, { policy: { maxConcurrency: 3 } });

  // 并行时序重叠
  const r1 = runFor(cfg, "step-s1");
  const r2 = runFor(cfg, "step-s2");
  assert(failures, "并行", Boolean(r1 && r2), `两步都应执行，实际 runs=${JSON.stringify(cfg.runs.map((r) => r.group))}`);
  if (r1 && r2) {
    const overlap = r1.start < r2.end && r2.start < r1.end;
    assert(
      failures,
      "并行",
      overlap,
      `两个无依赖步骤执行窗口应重叠：s1=[${r1.start},${r1.end}] s2=[${r2.start},${r2.end}]`,
    );
  }

  // 事件完整性：plan JSON 可解析
  const planEv = events.find((event) => event.rawType === "orchestrator.plan");
  assert(failures, "完整性", Boolean(planEv), "应有 orchestrator.plan 事件");
  if (planEv) {
    assert(failures, "完整性", planEv.kind === "plan" && planEv.group === "plan" && planEv.status === "completed", "plan 事件字段应为 kind=plan/group=plan/status=completed");
    let plan: { version?: number; task?: string; steps?: unknown[] } | null = null;
    try {
      plan = JSON.parse(planEv.body);
    } catch {
      plan = null;
    }
    assert(failures, "完整性", plan !== null, "plan body 应可 JSON 解析");
    if (plan) {
      assert(failures, "完整性", plan.version === 1, `plan.version 应为 1，实际 ${plan.version}`);
      assert(failures, "完整性", Array.isArray(plan.steps) && plan.steps.length === 2, "plan.steps 应含 2 步");
      const ok = (plan.steps ?? []).every((raw) => {
        const s = raw as Record<string, unknown>;
        return (
          typeof s.id === "string" &&
          typeof s.title === "string" &&
          typeof s.runnerId === "string" &&
          typeof s.runnerLabel === "string" &&
          Array.isArray(s.dependsOn)
        );
      });
      assert(failures, "完整性", ok, "每个 plan 步骤应含 id/title/runnerId/runnerLabel/dependsOn");
    }
  }

  // 每步都有 step 事件且到达终态
  const steps = stepEvents(events);
  for (const id of ["s1", "s2"]) {
    const forStep = steps.filter((s) => s.body.stepId === id);
    assert(failures, "完整性", forStep.length > 0, `步骤 ${id} 应有 step 事件`);
    const terminal = forStep.some((s) => ["completed", "failed", "skipped"].includes(s.body.state));
    assert(failures, "完整性", terminal, `步骤 ${id} 应到达终态`);
  }

  // 最终 message 唯一且无 group
  const finals = events.filter((event) => event.kind === "message" && !event.group);
  assert(failures, "完整性", finals.length === 1, `最终无 group 的 message 应唯一，实际 ${finals.length}`);
  if (finals.length === 1) {
    assert(failures, "完整性", finals[0]!.status === "completed", "最终 message 应为 completed");
    assert(failures, "完整性", finals[0]!.body === "SYNTH_FINAL", `最终 message 应为合成结果，实际「${finals[0]!.body}」`);
  }
}

/** 2) 依赖上下文注入。 */
async function checkContextInjection(failures: string[]): Promise<void> {
  const cfg: MockConfig = {
    runners: [
      { id: "brain", label: "主脑" },
      { id: "a", label: "抓取器" },
      { id: "b", label: "分析器" },
    ],
    planJson: JSON.stringify([
      planStep("s1", "a", "取数", "整理原始数据"),
      planStep("s2", "b", "分析", "基于上游做分析", ["s1"]),
    ]),
    synthText: "SYNTH",
    behavior: (runnerId, input) => {
      if (input.group === "step-s1") {
        return { delayMs: 10, result: "text", text: "ALPHA_RESULT" };
      }
      return { delayMs: 10, result: "text", text: "BETA" };
    },
    runs: [],
  };
  await runOrchestration(cfg);

  const r1 = runFor(cfg, "step-s1");
  const r2 = runFor(cfg, "step-s2");
  // 无依赖步骤不注入：content 应等于 instruction 原文
  assert(failures, "上下文", r1?.content === "整理原始数据", `无依赖步骤不应注入上下文，实际「${r1?.content}」`);
  // 下游步骤注入上游产出 + 来源标注
  assert(failures, "上下文", (r2?.content ?? "").includes("ALPHA_RESULT"), "下游步骤 content 应含上游产出 ALPHA_RESULT");
  assert(failures, "上下文", (r2?.content ?? "").includes("取数 · 抓取器"), "下游步骤 content 应标注来源「步骤标题 · runnerLabel」");
  assert(failures, "上下文", (r2?.content ?? "").includes("基于上游做分析"), "下游步骤 content 应保留自身 instruction");
}

/** 3) 重试换人（含清空部分产出）。 */
async function checkRetrySwitch(failures: string[]): Promise<void> {
  const cfg: MockConfig = {
    runners: [
      { id: "brain", label: "主脑" },
      { id: "flaky", label: "易错器" },
    ],
    planJson: JSON.stringify([planStep("s1", "flaky", "编译", "编译工程")]),
    behavior: (runnerId, input) => {
      if (input.group === "step-s1") {
        if (runnerId === "flaky") {
          return { delayMs: 10, result: "throw", partialText: "PARTIAL_FLAKY", errMsg: "编译崩了" };
        }
        return { delayMs: 10, result: "text", text: "BRAIN_OK" };
      }
      return { delayMs: 5, result: "text", text: "x" };
    },
    runs: [],
  };
  const events = await runOrchestration(cfg, { policy: { maxAttempts: 2 } });
  const steps = stepEvents(events).filter((s) => s.body.stepId === "s1");
  const seq = steps.map((s) => `${s.body.state}:${s.body.runnerId}#${s.body.attempt}`);

  assert(failures, "重试", steps.some((s) => s.body.state === "running" && s.body.runnerId === "flaky"), `应有 flaky 首跑 running，序列=${seq.join(" ")}`);
  const retry = steps.find((s) => s.body.state === "retrying");
  assert(failures, "重试", Boolean(retry), `应有 retrying 事件，序列=${seq.join(" ")}`);
  assert(failures, "重试", retry?.ev.status === "updated", "retrying 事件 status 应为 updated");
  assert(failures, "重试", retry?.body.runnerId === "brain", `重试应换人到 brain，实际 ${retry?.body.runnerId}`);
  assert(failures, "重试", steps.some((s) => s.body.state === "running" && s.body.runnerId === "brain" && s.body.attempt === 2), "应有 brain 第 2 次 running");
  assert(failures, "重试", steps.some((s) => s.body.state === "completed" && s.body.runnerId === "brain"), "brain 应最终 completed");

  const finals = events.filter((event) => event.kind === "message" && !event.group);
  assert(failures, "重试", finals.length === 1 && finals[0]!.body === "BRAIN_OK", `最终应为 BRAIN_OK，实际「${finals[0]?.body}」`);
  assert(failures, "重试", !(finals[0]?.body ?? "").includes("PARTIAL_FLAKY"), "失败 attempt 的部分产出应被清空、不进最终结果");
}

/** 4) 依赖失败跳过（含链式传播）。 */
async function checkSkipPropagation(failures: string[]): Promise<void> {
  const cfg: MockConfig = {
    runners: [
      { id: "brain", label: "主脑" },
      { id: "worker", label: "执行器" },
    ],
    planJson: JSON.stringify([
      planStep("s1", "worker", "根", "根任务"),
      planStep("s2", "worker", "中", "中间任务", ["s1"]),
      planStep("s3", "worker", "叶", "末端任务", ["s2"]),
    ]),
    behavior: (runnerId, input) => {
      if (input.group === "step-s1") {
        return { delayMs: 10, result: "throw", errMsg: "根任务失败" };
      }
      return { delayMs: 10, result: "text", text: "不应执行" };
    },
    runs: [],
  };
  const events = await runOrchestration(cfg, { policy: { maxAttempts: 1 } });
  const steps = stepEvents(events);

  const s1Failed = steps.some((s) => s.body.stepId === "s1" && s.body.state === "failed");
  assert(failures, "跳过", s1Failed, "s1 应 failed");
  const s2 = steps.find((s) => s.body.stepId === "s2" && s.body.state === "skipped");
  const s3 = steps.find((s) => s.body.stepId === "s3" && s.body.state === "skipped");
  assert(failures, "跳过", Boolean(s2), "s2 应 skipped（直接依赖失败）");
  assert(failures, "跳过", Boolean(s3), "s3 应 skipped（间接依赖失败，链式传播）");
  assert(failures, "跳过", (s2?.body.detail ?? "").includes("根"), `s2 skip detail 应注明因「根」步骤，实际「${s2?.body.detail}」`);
  assert(failures, "跳过", (s3?.body.detail ?? "").includes("中"), `s3 skip detail 应注明因「中」步骤，实际「${s3?.body.detail}」`);
  // 被跳过的步骤不派发（无 running 事件、无 run 记录）
  assert(failures, "跳过", !steps.some((s) => (s.body.stepId === "s2" || s.body.stepId === "s3") && s.body.state === "running"), "被跳过步骤不应有 running 事件");
  assert(failures, "跳过", !runFor(cfg, "step-s2") && !runFor(cfg, "step-s3"), "被跳过步骤不应实际执行");
  // 全失败/跳过 → 最终如实说明
  const finals = events.filter((event) => event.kind === "message" && !event.group);
  assert(failures, "跳过", finals.length === 1, `最终 message 应唯一，实际 ${finals.length}`);
  assert(failures, "跳过", (finals[0]?.body ?? "").includes("未产出有效结果"), `最终应如实说明全部未成功，实际「${finals[0]?.body}」`);
}

/** 5) 并发上限=1 退化串行。 */
async function checkSerialDegrade(failures: string[]): Promise<void> {
  const cfg: MockConfig = {
    runners: [
      { id: "brain", label: "主脑" },
      { id: "a", label: "甲" },
      { id: "b", label: "乙" },
    ],
    planJson: JSON.stringify([
      planStep("s1", "a", "步骤一", "任务一"),
      planStep("s2", "b", "步骤二", "任务二"),
    ]),
    synthText: "SYNTH",
    behavior: (runnerId) => ({ delayMs: 40, result: "text", text: `${runnerId}-ok` }),
    runs: [],
  };
  await runOrchestration(cfg, { policy: { maxConcurrency: 1 } });
  const r1 = runFor(cfg, "step-s1");
  const r2 = runFor(cfg, "step-s2");
  assert(failures, "串行", Boolean(r1 && r2), "两步都应执行");
  if (r1 && r2) {
    // 串行：s2 必须在 s1 结束后才开始（窗口不重叠）
    assert(failures, "串行", r2.start >= r1.end, `并发=1 应串行：s1.end=${r1.end} s2.start=${r2.start}`);
    const overlap = r1.start < r2.end && r2.start < r1.end;
    assert(failures, "串行", !overlap, "并发=1 时两步执行窗口不应重叠");
  }
}

/** 7) abort 后不再派发。 */
async function checkAbortNoDispatch(failures: string[]): Promise<void> {
  const controller = new AbortController();
  const cfg: MockConfig = {
    runners: [
      { id: "brain", label: "主脑" },
      { id: "a", label: "甲" },
    ],
    planJson: JSON.stringify([
      planStep("s1", "a", "步骤一", "任务一"),
      planStep("s2", "a", "步骤二", "任务二"),
      planStep("s3", "a", "步骤三", "任务三"),
    ]),
    behavior: (runnerId, input) => {
      if (input.group === "step-s1") {
        // s1 完成瞬间触发中止：s2/s3 尚未派发
        return { delayMs: 10, result: "text", text: "DONE1", onComplete: () => controller.abort() };
      }
      return { delayMs: 10, result: "text", text: "不应执行" };
    },
    runs: [],
  };
  const events = await runOrchestration(cfg, { policy: { maxConcurrency: 1 }, signal: controller.signal });
  const steps = stepEvents(events);

  assert(failures, "中止", steps.some((s) => s.body.stepId === "s1" && s.body.state === "completed"), "s1 应在中止前 completed");
  const s2 = steps.find((s) => s.body.stepId === "s2" && s.body.state === "skipped");
  const s3 = steps.find((s) => s.body.stepId === "s3" && s.body.state === "skipped");
  assert(failures, "中止", Boolean(s2 && s3), "中止后 s2/s3 应 skipped");
  assert(failures, "中止", (s2?.body.detail ?? "").includes("已中止"), `s2 skip detail 应为「已中止」，实际「${s2?.body.detail}」`);
  assert(failures, "中止", (s3?.body.detail ?? "").includes("已中止"), `s3 skip detail 应为「已中止」，实际「${s3?.body.detail}」`);
  // 中止后不再派发：s2/s3 无 running、无实际执行
  assert(failures, "中止", !steps.some((s) => (s.body.stepId === "s2" || s.body.stepId === "s3") && s.body.state === "running"), "中止后不应有新 running 事件");
  assert(failures, "中止", !runFor(cfg, "step-s2") && !runFor(cfg, "step-s3"), "中止后未启动步骤不应实际执行");
  // s1 是唯一有效产出 → 直接输出
  const finals = events.filter((event) => event.kind === "message" && !event.group);
  assert(failures, "中止", finals.length === 1 && finals[0]!.body === "DONE1", `最终应为 s1 直接产出 DONE1，实际「${finals[0]?.body}」`);
}

/** 8) 修复[1]：只带 source、不带 group 的子事件应被回填 group，不漏成第二条游离气泡。 */
async function checkSourceOnlyBackfill(failures: string[]): Promise<void> {
  const cfg: MockConfig = {
    runners: [
      { id: "brain", label: "主脑" },
      { id: "a", label: "甲" },
    ],
    planJson: JSON.stringify([planStep("s1", "a", "唯一步", "干活")]),
    behavior: (runnerId, input) => {
      if (input.group === "step-s1") {
        return { delayMs: 10, result: "text", text: "MAIN", extraSourced: "LEAK" };
      }
      return { delayMs: 5, result: "text", text: "x" };
    },
    runs: [],
  };
  const events = await runOrchestration(cfg);
  const noGroupFinals = events.filter((e) => e.kind === "message" && e.status === "completed" && !e.group);
  assert(
    failures,
    "回填",
    noGroupFinals.length === 1,
    `只带 source 的子消息应被回填 group；无 group 的 completed message 应仅剩最终 1 条，实际 ${noGroupFinals.length}`,
  );
  const leak = events.find((e) => e.body === "LEAK");
  assert(failures, "回填", leak?.group === "step-s1", `带 source 的子消息应被回填 group=step-s1，实际 ${leak?.group}`);
  assert(failures, "回填", leak?.source === "外部执行体", "已有的 source 应保留、不被覆盖");
}

/** 9) 修复[8]：并行 fan-out 进行中被中止 → 在跑步骤记 skipped「已中止」而非 failed。 */
async function checkAbortDuringParallel(failures: string[]): Promise<void> {
  const controller = new AbortController();
  const cfg: MockConfig = {
    runners: [
      { id: "brain", label: "主脑" },
      { id: "a", label: "甲" },
      { id: "b", label: "乙" },
      { id: "c", label: "丙" },
    ],
    planJson: JSON.stringify([
      planStep("s1", "a", "快步", "很快完成然后中止"),
      planStep("s2", "b", "慢步一", "长时间任务"),
      planStep("s3", "c", "慢步二", "长时间任务"),
    ]),
    behavior: (runnerId, input) => {
      if (input.group === "step-s1") {
        return { delayMs: 10, result: "text", text: "FAST", onComplete: () => controller.abort() };
      }
      return { delayMs: 300, result: "text", text: "不应完成" };
    },
    runs: [],
  };
  const events = await runOrchestration(cfg, {
    policy: { maxConcurrency: 3, maxAttempts: 2 },
    signal: controller.signal,
  });
  const steps = stepEvents(events);

  assert(failures, "并行中止", steps.some((s) => s.body.stepId === "s1" && s.body.state === "completed"), "s1 应在中止前 completed");
  for (const id of ["s2", "s3"]) {
    const ran = steps.some((s) => s.body.stepId === id && s.body.state === "running");
    assert(failures, "并行中止", ran, `${id} 应已进入 running（证明是在并行执行时被中止，而非未派发）`);
    assert(failures, "并行中止", Boolean(runFor(cfg, `step-${id}`)), `${id} 应确有 run 记录（确实启动过）`);
    const skipped = steps.find((s) => s.body.stepId === id && s.body.state === "skipped");
    assert(failures, "并行中止", Boolean(skipped), `${id} 在跑时被中止应记 skipped 而非 failed`);
    assert(failures, "并行中止", (skipped?.body.detail ?? "").includes("已中止"), `${id} skip detail 应为「已中止」，实际「${skipped?.body.detail}」`);
    assert(failures, "并行中止", !steps.some((s) => s.body.stepId === id && s.body.state === "failed"), `${id} 不应被记为 failed`);
  }
}

/** 10) 计划成环 → 线性化打破环，仍可执行、不死锁。 */
async function checkCycleBreaking(failures: string[]): Promise<void> {
  const cfg: MockConfig = {
    runners: [
      { id: "brain", label: "主脑" },
      { id: "a", label: "甲" },
      { id: "b", label: "乙" },
    ],
    planJson: JSON.stringify([
      planStep("s1", "a", "环一", "任务一", ["s2"]),
      planStep("s2", "b", "环二", "任务二", ["s1"]),
    ]),
    synthText: "SYNTH",
    behavior: (runnerId) => ({ delayMs: 10, result: "text", text: `${runnerId}-ok` }),
    runs: [],
  };
  const events = await runOrchestration(cfg);
  const planEv = events.find((e) => e.rawType === "orchestrator.plan");
  const plan = planEv ? (JSON.parse(planEv.body) as { steps: { id: string; dependsOn: string[] }[] }) : null;
  const s1dep = plan?.steps.find((s) => s.id === "s1")?.dependsOn ?? ["?"];
  const s2dep = plan?.steps.find((s) => s.id === "s2")?.dependsOn ?? ["?"];
  assert(failures, "环", s1dep.length === 0, `打破环后 s1 应无依赖，实际 ${JSON.stringify(s1dep)}`);
  assert(failures, "环", s2dep.length === 1 && s2dep[0] === "s1", `打破环后 s2 应依赖 s1（线性化），实际 ${JSON.stringify(s2dep)}`);
  const steps = stepEvents(events);
  for (const id of ["s1", "s2"]) {
    assert(failures, "环", steps.some((s) => s.body.stepId === id && s.body.state === "completed"), `${id} 应 completed（成环未导致死锁）`);
  }
  const finals = events.filter((e) => e.kind === "message" && !e.group);
  assert(failures, "环", finals.length === 1, `最终 message 应唯一，实际 ${finals.length}`);
}

/** 11) LLM 原始 id 归一化 + dependsOn 用原始 id 引用 → 翻译为 s1/s2。 */
async function checkIdNormalization(failures: string[]): Promise<void> {
  const cfg: MockConfig = {
    runners: [
      { id: "brain", label: "主脑" },
      { id: "a", label: "抓取器" },
      { id: "b", label: "解析器" },
    ],
    planJson: JSON.stringify([
      planStep("fetch", "a", "抓取", "抓取数据"),
      planStep("parse", "b", "解析", "解析上游产出", ["fetch"]),
    ]),
    synthText: "SYNTH",
    behavior: (runnerId, input) => {
      if (input.group === "step-s1") {
        return { delayMs: 10, result: "text", text: "FETCHED" };
      }
      return { delayMs: 10, result: "text", text: "PARSED" };
    },
    runs: [],
  };
  const events = await runOrchestration(cfg);
  const planEv = events.find((e) => e.rawType === "orchestrator.plan");
  const plan = planEv ? (JSON.parse(planEv.body) as { steps: { id: string; dependsOn: string[] }[] }) : null;
  const ids = (plan?.steps ?? []).map((s) => s.id);
  assert(failures, "归一化", ids.length === 2 && ids[0] === "s1" && ids[1] === "s2", `原始 id fetch/parse 应归一化为 s1/s2，实际 ${JSON.stringify(ids)}`);
  const s2dep = plan?.steps.find((s) => s.id === "s2")?.dependsOn ?? [];
  assert(failures, "归一化", s2dep.length === 1 && s2dep[0] === "s1", `dependsOn 原始 id「fetch」应翻译为 s1，实际 ${JSON.stringify(s2dep)}`);
  const r2 = runFor(cfg, "step-s2");
  assert(failures, "归一化", (r2?.content ?? "").includes("FETCHED"), "翻译后依赖应生效：s2 content 应含 s1 产出 FETCHED");
}

/** 12) plan 解析为空 → 单步兜底直接执行整个任务。 */
async function checkEmptyPlanFallback(failures: string[]): Promise<void> {
  const cfg: MockConfig = {
    runners: [
      { id: "brain", label: "主脑" },
      { id: "a", label: "甲" },
    ],
    planJson: "这不是一个 JSON 数组，纯属胡言乱语",
    behavior: (runnerId, input) => {
      if (input.group === "step-s1") {
        return { delayMs: 10, result: "text", text: "FALLBACK_DONE" };
      }
      return { delayMs: 5, result: "text", text: "x" };
    },
    runs: [],
  };
  const events = await runOrchestration(cfg, { task: "帮我做一件完整的事" });
  const planEv = events.find((e) => e.rawType === "orchestrator.plan");
  const plan = planEv ? (JSON.parse(planEv.body) as { steps: { id: string; runnerId: string }[] }) : null;
  assert(failures, "兜底", (plan?.steps.length ?? 0) === 1, `空计划应兜底为单步，实际 ${plan?.steps.length}`);
  assert(failures, "兜底", plan?.steps[0]?.runnerId === "brain", `兜底步骤应派给 brain，实际 ${plan?.steps[0]?.runnerId}`);
  const r1 = runFor(cfg, "step-s1");
  assert(failures, "兜底", r1?.content === "帮我做一件完整的事", `兜底步骤 content 应为整个任务原文，实际「${r1?.content}」`);
  const finals = events.filter((e) => e.kind === "message" && !e.group);
  assert(failures, "兜底", finals.length === 1 && finals[0]!.body === "FALLBACK_DONE", `最终应为兜底步骤产出，实际「${finals[0]?.body}」`);
}

/** 13) 产出空文本视为失败 → 触发重试换人。 */
async function checkEmptyTextFailure(failures: string[]): Promise<void> {
  const cfg: MockConfig = {
    runners: [
      { id: "brain", label: "主脑" },
      { id: "mute", label: "哑器" },
    ],
    planJson: JSON.stringify([planStep("s1", "mute", "产出", "生成内容")]),
    behavior: (runnerId, input) => {
      if (input.group === "step-s1") {
        if (runnerId === "mute") {
          return { delayMs: 10, result: "empty" };
        }
        return { delayMs: 10, result: "text", text: "BRAIN_TEXT" };
      }
      return { delayMs: 5, result: "text", text: "x" };
    },
    runs: [],
  };
  const events = await runOrchestration(cfg, { policy: { maxAttempts: 2 } });
  const steps = stepEvents(events).filter((s) => s.body.stepId === "s1");
  const retry = steps.find((s) => s.body.state === "retrying");
  assert(failures, "空产出", Boolean(retry), "空文本产出应视为失败并触发 retrying");
  assert(failures, "空产出", (retry?.body.detail ?? "").includes("产出为空"), `重试原因应为「产出为空」，实际「${retry?.body.detail}」`);
  assert(failures, "空产出", steps.some((s) => s.body.state === "completed" && s.body.runnerId === "brain"), "换 brain 后应 completed");
  const finals = events.filter((e) => e.kind === "message" && !e.group);
  assert(failures, "空产出", finals.length === 1 && finals[0]!.body === "BRAIN_TEXT", `最终应为 brain 产出，实际「${finals[0]?.body}」`);
}

/** 14) 上下文交接：多依赖 + 超长产出 → 每依赖截 2000、合计超 8000 丢最早并注明。 */
async function checkContextTruncation(failures: string[]): Promise<void> {
  const big = (mark: string): string => mark + "D".repeat(5000);
  const cfg: MockConfig = {
    runners: [
      { id: "brain", label: "主脑" },
      { id: "a", label: "甲" },
      { id: "b", label: "乙" },
      { id: "c", label: "丙" },
      { id: "d", label: "丁" },
      { id: "e", label: "戊" },
    ],
    planJson: JSON.stringify([
      planStep("s1", "a", "d1", "产出一"),
      planStep("s2", "b", "d2", "产出二"),
      planStep("s3", "c", "d3", "产出三"),
      planStep("s4", "d", "d4", "产出四"),
      planStep("s5", "e", "汇总", "综合上游", ["s1", "s2", "s3", "s4"]),
    ]),
    synthText: "SYNTH",
    behavior: (runnerId, input) => {
      const g = input.group ?? "";
      if (g === "step-s1") return { delayMs: 5, result: "text", text: big("MARK_A") };
      if (g === "step-s2") return { delayMs: 5, result: "text", text: big("MARK_B") };
      if (g === "step-s3") return { delayMs: 5, result: "text", text: big("MARK_C") };
      if (g === "step-s4") return { delayMs: 5, result: "text", text: big("MARK_D") };
      if (g === "step-s5") return { delayMs: 5, result: "text", text: "S5_OK" };
      return { delayMs: 5, result: "text", text: "x" };
    },
    runs: [],
  };
  await runOrchestration(cfg, { policy: { maxConcurrency: 4 } });
  const c5 = runFor(cfg, "step-s5")?.content ?? "";
  assert(failures, "截断", c5.includes("（已截断）"), "每个依赖产出应被截断（含「（已截断）」标记）");
  assert(failures, "截断", c5.includes("已省略较早的 1 个"), `合计超 8000 应丢弃最早 1 个依赖并注明，content 头部=「${c5.slice(0, 40)}」`);
  assert(failures, "截断", !c5.includes("MARK_A"), "最早的依赖（s1/MARK_A）应被丢弃");
  assert(failures, "截断", c5.includes("MARK_B") && c5.includes("MARK_C") && c5.includes("MARK_D"), "较新的 3 个依赖（B/C/D）应保留");
}

/** 15) 无可用执行体 → 报错、不崩溃、不产出 message。 */
async function checkNoCandidates(failures: string[]): Promise<void> {
  const cfg: MockConfig = { runners: [], planJson: "[]", behavior: () => ({ delayMs: 1, result: "text", text: "x" }), runs: [] };
  const events = await runOrchestration(cfg);
  const err = events.find((e) => e.kind === "error");
  assert(failures, "无执行体", Boolean(err), "无可用执行体应发 error 事件");
  assert(failures, "无执行体", (err?.title ?? "").includes("没有可用的执行体"), `error 标题应为「没有可用的执行体」，实际「${err?.title}」`);
  assert(failures, "无执行体", !events.some((e) => e.kind === "message"), "无执行体时不应产出 message");
}

/** 16) 未知依赖 / 自引用依赖 → 丢弃，不误跳过、不死锁。 */
async function checkUnknownSelfDep(failures: string[]): Promise<void> {
  const cfg: MockConfig = {
    runners: [
      { id: "brain", label: "主脑" },
      { id: "a", label: "甲" },
      { id: "b", label: "乙" },
    ],
    planJson: JSON.stringify([
      planStep("s1", "a", "一", "任务一", ["ghost"]),
      planStep("s2", "b", "二", "任务二", ["s2"]),
    ]),
    synthText: "SYNTH",
    behavior: (runnerId) => ({ delayMs: 10, result: "text", text: `${runnerId}-ok` }),
    runs: [],
  };
  const events = await runOrchestration(cfg);
  const planEv = events.find((e) => e.rawType === "orchestrator.plan");
  const plan = planEv ? (JSON.parse(planEv.body) as { steps: { id: string; dependsOn: string[] }[] }) : null;
  assert(failures, "脏依赖", (plan?.steps.find((s) => s.id === "s1")?.dependsOn.length ?? -1) === 0, "未知依赖 ghost 应被丢弃");
  assert(failures, "脏依赖", (plan?.steps.find((s) => s.id === "s2")?.dependsOn.length ?? -1) === 0, "自引用依赖应被丢弃");
  const steps = stepEvents(events);
  for (const id of ["s1", "s2"]) {
    assert(failures, "脏依赖", steps.some((s) => s.body.stepId === id && s.body.state === "completed"), `${id} 应 completed（脏依赖不致跳过/死锁）`);
    assert(failures, "脏依赖", !steps.some((s) => s.body.stepId === id && s.body.state === "skipped"), `${id} 不应被跳过`);
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const failures: string[] = [];
  await checkOverlapAndIntegrity(failures);
  await checkContextInjection(failures);
  await checkRetrySwitch(failures);
  await checkSkipPropagation(failures);
  await checkSerialDegrade(failures);
  await checkAbortNoDispatch(failures);
  await checkSourceOnlyBackfill(failures);
  await checkAbortDuringParallel(failures);
  await checkCycleBreaking(failures);
  await checkIdNormalization(failures);
  await checkEmptyPlanFallback(failures);
  await checkEmptyTextFailure(failures);
  await checkContextTruncation(failures);
  await checkNoCandidates(failures);
  await checkUnknownSelfDep(failures);

  if (failures.length === 0) {
    console.log(
      "PASS: 并行编排调度器冒烟测试通过（时序重叠 + 上下文注入/截断 + 重试换人 + 空产出判失败 + 依赖跳过链式传播 + 并发=1 退化串行 + 事件完整性 + 中止(串行/并行) + source 回填 + 成环线性化 + id 归一化 + 空计划兜底 + 无执行体 + 脏依赖丢弃）。",
    );
    process.exitCode = 0;
  } else {
    console.log("FAIL: 并行编排调度器冒烟测试未通过。");
    for (const failure of failures) {
      console.log(`  - ${failure}`);
    }
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.log("FAIL: 冒烟测试抛出异常。");
  console.log(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
