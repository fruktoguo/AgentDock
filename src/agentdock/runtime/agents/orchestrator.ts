import { errorMessage, makeEvent, safeJsonParse } from "../../adapters/shared.js";
import type { DriverRegistry } from "../driver-registry.js";
import type { AgentDriver, AgentEvent, RunTurnInput, RunnerOption } from "../types.js";

type ListRunners = () => Promise<RunnerOption[]>;

/** 规范化后的计划步骤（内部结构 + 计划事件 payload 的来源）。 */
type PlanStep = {
  id: string; // 标准化为 "s1"、"s2"…（缺失按序补齐）
  title: string;
  runnerId: string; // 必须是候选 runner id，否则回退 brain
  instruction: string; // 不进看板 JSON，人读 dispatch 事件里可见
  dependsOn: string[]; // 依赖步骤 id；空数组 = 可立即执行
};

/** 编排策略：并发上限 + 每步最多尝试次数。 */
type OrchestrationPolicy = {
  maxConcurrency: number; // 默认 3
  maxAttempts: number; // 默认 2（首跑 + 1 次重试/换人）
};

/** 某步的最终产出，供上下文交接与合成使用。 */
type StepOutput = {
  title: string;
  label: string;
  text: string;
};

/** 单次 attempt 的运行结果。 */
type RunResult = { text: string; errored: boolean; reason?: string };

/** 步骤运行状态。 */
type RunState = "pending" | "running" | "completed" | "failed" | "skipped";

/** 步骤事件里携带的 state（比 RunState 多一个瞬时的 retrying）。 */
type StepEventState = "running" | "retrying" | "completed" | "failed" | "skipped";

const ORCH_LABEL = "编排 Agent";
const PLAN_GROUP = "plan";
const SYNTH_GROUP = "synthesis";
const PLAN_RAW_TYPE = "orchestrator.plan";
const STEP_RAW_TYPE = "orchestrator.step";

const DEP_CHARS_PER_STEP = 2000; // 上下文交接：每个依赖产出截断
const DEP_CHARS_TOTAL = 8000; // 上下文交接：依赖产出合计上限
const SYNTH_CHARS_PER_STEP = 6000; // 合成 prompt：每步产出截断

/**
 * 编排 Agent：先让「主脑」（第一个可用 runner）产出 JSON 计划，
 * 再按依赖关系**并行**派发就绪步骤给各 runner，最后合成最终答案。
 *
 * 对外 runTurn 仍是单个 async generator、输出串行化事件流；内部通过一个
 * 基于 Promise 的合流队列（Merger）做有界并发 fan-in：就绪步骤最多同时
 * maxConcurrency 个在跑，子事件一到达就立刻转发，绝不等全部跑完再统一 yield。
 *
 * 子任务事件都带 group=step-<id> + source=runnerLabel，便于前端分组可视化；
 * 只有最终合成消息不带 group，从而成为唯一的 assistant 气泡。
 */
export class OrchestratorDriver implements AgentDriver {
  private readonly policy: OrchestrationPolicy;

  constructor(
    private readonly registry: DriverRegistry,
    private readonly listRunners: ListRunners,
    policy?: Partial<OrchestrationPolicy>,
  ) {
    this.policy = {
      maxConcurrency: Math.max(1, policy?.maxConcurrency ?? 3),
      maxAttempts: Math.max(1, policy?.maxAttempts ?? 2),
    };
  }

  async *runTurn(input: RunTurnInput): AsyncGenerator<AgentEvent> {
    const task = input.content;

    // a. 找出可用的执行体
    const options = await this.listRunners();
    const candidates = options.filter((option) => option.available && option.backend !== "orchestrator");
    if (candidates.length === 0) {
      yield makeEvent(
        this.orchInput(input),
        "error",
        "没有可用的执行体",
        "请先安装并启用一个 CLI（codex/claude），或在设置里配置一个带密钥的 API provider。",
        "failed",
      );
      return;
    }
    const brain = candidates[0]!;

    // b. 规划（顺序阶段）
    yield makeEvent(this.groupInput(input, PLAN_GROUP), "plan", "规划任务", `由「${brain.label}」拆解任务…`, "started");
    const planRun = yield* this.runOnGen(input, brain, this.buildPlanPrompt(task, candidates), PLAN_GROUP);
    let plan = this.parsePlan(planRun.text, candidates);
    if (plan.length === 0) {
      // 兜底：解析为空 → 单步直接执行整个任务
      plan = [{ id: "s1", title: "直接执行", runnerId: brain.id, instruction: task, dependsOn: [] }];
    }
    // 结构化计划事件（body 为 JSON），供看板消费
    yield makeEvent(
      this.groupInput(input, PLAN_GROUP),
      "plan",
      "规划完成",
      this.buildPlanJson(task, plan, candidates),
      "completed",
      PLAN_RAW_TYPE,
    );

    // c. 并行 fan-out：就绪驱动 + 有界并发 + 合流转发
    const states = new Map<string, RunState>(plan.map((step) => [step.id, "pending"] as const));
    const results = new Map<string, StepOutput>();
    yield* this.runFanOut(input, plan, candidates, brain, states, results);

    // d. 收口 / 合成（顺序阶段）
    yield* this.finalize(input, task, plan, states, results, brain);
  }

  // -------------------------------------------------------------------------
  // 并行调度：核心
  // -------------------------------------------------------------------------

  /**
   * 有界并发 fan-in：dependsOn 全部 completed 的步骤进就绪队列，最多同时
   * maxConcurrency 个在跑；子事件经 Merger 按到达序串行 yield。某步完成后解锁
   * 后继并补位启动。依赖失败/中止的步骤发 skipped 并沿依赖链传播。
   *
   * 提前 return/throw（消费端 break）时：内部 AbortController 取消所有在跑的
   * 子 driver，并 await 全部 worker，绝不泄漏悬挂 Promise。
   */
  private async *runFanOut(
    input: RunTurnInput,
    plan: PlanStep[],
    candidates: RunnerOption[],
    brain: RunnerOption,
    states: Map<string, RunState>,
    results: Map<string, StepOutput>,
  ): AsyncGenerator<AgentEvent> {
    const { maxConcurrency, maxAttempts } = this.policy;
    const stepById = new Map(plan.map((step) => [step.id, step] as const));
    const merger = new Merger<AgentEvent>();
    const workers = new Set<Promise<void>>();
    let active = 0;

    // 把外层 signal 链接到内部 controller：外层中止 or 提前退出都能取消子 driver。
    const abort = new AbortController();
    const outer = input.signal;
    const onOuterAbort = (): void => abort.abort();
    if (outer) {
      if (outer.aborted) {
        abort.abort();
      } else {
        outer.addEventListener("abort", onOuterAbort, { once: true });
      }
    }
    const subInput: RunTurnInput = { ...input, signal: abort.signal };

    const emit = (event: AgentEvent): void => merger.push(event);

    const skipStep = (step: PlanStep, detail: string): void => {
      states.set(step.id, "skipped");
      emit(this.stepEvent(input, step, this.resolveRunner(step, candidates, brain), "skipped", 0, detail));
    };

    const runStep = async (step: PlanStep): Promise<void> => {
      try {
        let attempt = 0;
        let target = this.resolveRunner(step, candidates, brain);
        for (;;) {
          attempt += 1;
          // 每次 attempt 都发结构化 running + 人读 dispatch（供 details 展开）
          emit(this.stepEvent(input, step, target, "running", attempt));
          emit(this.dispatchEvent(input, step, target));

          // 上下文交接：注入 dependsOn 步骤产出（每次 attempt 重新构建 = 清空上一次的部分产出）
          const content = this.buildStepContent(step, results);
          const result = await this.runAttempt(subInput, target, content, stepGroupId(step.id), emit);
          const ok = !result.errored && result.text.trim() !== "";
          if (ok) {
            results.set(step.id, { title: step.title, label: target.label, text: result.text });
            states.set(step.id, "completed");
            emit(this.stepEvent(input, step, target, "completed", attempt));
            return;
          }

          const reason = result.errored ? result.reason ?? "执行出错" : "产出为空";
          // 重试/换人：attempt 未耗尽且未中止 → 换个 runner 重跑
          if (attempt < maxAttempts && !abort.signal.aborted) {
            const next = this.pickRetryRunner(candidates, brain, target);
            emit(
              this.stepEvent(
                input,
                step,
                next,
                "retrying",
                attempt,
                `第 ${attempt} 次尝试失败（${reason}），改用「${next.label}」重试`,
              ),
            );
            target = next;
            continue;
          }
          // 中止导致的中断：按「已中止」跳过，而非 failed。
          // 协议 §2/§3：failed 专指「尝试次数耗尽」；被中止的在跑步骤与未启动步骤应一致地记为 skipped，
          // 避免出现「failed 但 attempt 未耗尽」的自相矛盾状态，也避免把子驱动的原始中止错误串透传到卡片。
          if (abort.signal.aborted) {
            states.set(step.id, "skipped");
            emit(this.stepEvent(input, step, target, "skipped", attempt, "已中止"));
            return;
          }
          // 尝试耗尽 → failed
          states.set(step.id, "failed");
          emit(this.stepEvent(input, step, target, "failed", attempt, reason));
          return;
        }
      } catch (error) {
        // 兜底：worker 绝不向外抛，保证不产生 unhandled rejection
        states.set(step.id, "failed");
        emit(
          makeEvent(this.groupInput(input, stepGroupId(step.id)), "error", "步骤异常", errorMessage(error), "failed"),
        );
        emit(this.stepEvent(input, step, this.resolveRunner(step, candidates, brain), "failed", 0, errorMessage(error)));
      } finally {
        active -= 1;
        pump();
      }
    };

    const pump = (): void => {
      if (merger.closed) {
        return;
      }
      // 1. 中止：不再派发新步骤，未启动的 pending 步骤全部 skipped（已中止）
      if (abort.signal.aborted) {
        for (const step of plan) {
          if (states.get(step.id) === "pending") {
            skipStep(step, "已中止");
          }
        }
      }
      // 2. 依赖失败/跳过 → 本步 skipped，并沿依赖链级联传播到间接依赖
      for (;;) {
        let changed = false;
        for (const step of plan) {
          if (states.get(step.id) !== "pending") {
            continue;
          }
          const blocker = step.dependsOn.find((dep) => {
            const st = states.get(dep);
            return st === "failed" || st === "skipped";
          });
          if (blocker) {
            const b = stepById.get(blocker);
            skipStep(step, `因依赖步骤「${b?.title ?? blocker}」未成功而跳过`);
            changed = true;
          }
        }
        if (!changed) {
          break;
        }
      }
      // 3. 就绪驱动：dependsOn 全部 completed 的步骤进队，补位到并发上限
      while (active < maxConcurrency && !abort.signal.aborted) {
        const next = plan.find(
          (step) =>
            states.get(step.id) === "pending" &&
            step.dependsOn.every((dep) => states.get(dep) === "completed"),
        );
        if (!next) {
          break;
        }
        states.set(next.id, "running");
        active += 1;
        const worker = runStep(next);
        workers.add(worker);
        void worker.finally(() => workers.delete(worker));
      }
      // 4. 收尾：无在跑、无 pending → 关闭合流队列
      if (active === 0 && !plan.some((step) => states.get(step.id) === "pending")) {
        merger.close();
      }
    };

    try {
      pump();
      for (;;) {
        const next = await merger.next();
        if (next.done) {
          break;
        }
        yield next.value;
      }
    } finally {
      if (outer) {
        outer.removeEventListener("abort", onOuterAbort);
      }
      abort.abort(); // 提前退出时取消所有在跑的子 driver
      merger.close();
      await Promise.allSettled([...workers]); // 不泄漏未 await 的子任务
    }
  }

  /** 选一个重试 runner：优先 brain 且尽量不同于刚失败者；无他选则原 runner 重跑。 */
  private pickRetryRunner(candidates: RunnerOption[], brain: RunnerOption, failed: RunnerOption): RunnerOption {
    if (brain.id !== failed.id) {
      return brain;
    }
    const other = candidates.find((option) => option.id !== failed.id);
    return other ?? failed;
  }

  /** 把 plan 里的 runnerId 解析成候选 option（规范化已保证有效，仍兜底 brain）。 */
  private resolveRunner(step: PlanStep, candidates: RunnerOption[], brain: RunnerOption): RunnerOption {
    return candidates.find((option) => option.id === step.runnerId) ?? brain;
  }

  // -------------------------------------------------------------------------
  // 单步执行 / 收口
  // -------------------------------------------------------------------------

  /**
   * 用指定 runner 跑一段内容，透传其事件（回填 group/source），把 completed
   * message 文本累计为产出。以 sink 回调转发事件，返回 attempt 结果（供并发 worker 用）。
   */
  private async runAttempt(
    outerInput: RunTurnInput,
    option: RunnerOption,
    content: string,
    group: string,
    sink: (event: AgentEvent) => void,
  ): Promise<RunResult> {
    const iterator = this.runOnGen(outerInput, option, content, group);
    for (;;) {
      const step = await iterator.next();
      if (step.done) {
        return step.value;
      }
      sink(step.value);
    }
  }

  /**
   * 顺序阶段（规划 / 合成）与并发 attempt 共用的执行核心：resolve driver、透传
   * 子事件并回填 group=<group> 与 source=runnerLabel、累计 completed message 文本。
   * 子步骤抛错 = errored:true（供上层判失败）；产出空文本由上层按空判失败。
   */
  private async *runOnGen(
    outerInput: RunTurnInput,
    option: RunnerOption,
    content: string,
    group: string,
  ): AsyncGenerator<AgentEvent, RunResult> {
    const resolved = this.registry.resolve(option.ref);
    if (!resolved.driver) {
      yield makeEvent(
        { ...outerInput, group, sourceLabel: option.label },
        "error",
        `无法运行 ${option.label}`,
        resolved.error ?? "未知错误",
        "failed",
      );
      return { text: "", errored: true, reason: resolved.error ?? "无法解析 runner" };
    }

    const subInput: RunTurnInput = {
      session: outerInput.session,
      content,
      runner: option.ref,
      provider: resolved.provider,
      model: option.ref.kind === "api" || option.ref.kind === "native" ? option.ref.model : undefined,
      signal: outerInput.signal,
      group,
      sourceLabel: option.label,
    };

    let text = "";
    try {
      for await (const event of resolved.driver.runTurn(subInput)) {
        // 有的 driver（如 codex）不读 input.group/sourceLabel，用自己的构造器发事件，
        // 这里回填 group/source，保证子任务事件能在前端归组、标注来源。
        // group 与 source 独立判断：只要缺 group 就补步骤组（保证任何 completed message
        // 都不会漏成无 group 的游离 assistant 气泡，破坏「最终唯一无 group message」不变量），
        // 只要缺 source 就补执行体名——兼容「只报 source、不懂 group」的第三方可插拔 driver。
        const stamped: AgentEvent =
          event.group === undefined || event.source === undefined
            ? {
                ...event,
                group: event.group === undefined ? group : event.group,
                source: event.source === undefined ? option.label : event.source,
              }
            : event;
        if (stamped.kind === "message" && stamped.status === "completed" && stamped.body.trim()) {
          text += (text ? "\n\n" : "") + stamped.body;
        }
        yield stamped;
      }
    } catch (error) {
      yield makeEvent(
        { ...outerInput, group, sourceLabel: option.label },
        "error",
        `${option.label} 执行失败`,
        errorMessage(error),
        "failed",
      );
      return { text, errored: true, reason: errorMessage(error) };
    }
    return { text, errored: false };
  }

  /** 收口：有效产出唯一→直接输出；>1→brain 合成；全 failed/skipped→如实说明。 */
  private async *finalize(
    input: RunTurnInput,
    task: string,
    plan: PlanStep[],
    states: Map<string, RunState>,
    results: Map<string, StepOutput>,
    brain: RunnerOption,
  ): AsyncGenerator<AgentEvent> {
    const outputs: StepOutput[] = [];
    for (const step of plan) {
      const output = results.get(step.id);
      if (output && output.text.trim()) {
        outputs.push(output);
      }
    }

    if (outputs.length === 0) {
      // 全部 failed/skipped：如实说明
      yield makeEvent(this.finalInput(input), "message", "编排结果", this.renderAllFailed(plan, states), "completed");
      return;
    }
    if (outputs.length === 1) {
      const finalText = outputs[0]!.text.trim() || "（子任务没有返回文本。）";
      yield makeEvent(this.finalInput(input), "message", "编排结果", finalText, "completed");
      return;
    }

    // >1 有效产出 → brain 合成（已中止则跳过合成，直接给回退汇总）
    if (input.signal?.aborted) {
      yield makeEvent(this.finalInput(input), "message", "编排结果", this.renderFallbackSummary(outputs), "completed");
      return;
    }
    yield makeEvent(
      this.groupInput(input, SYNTH_GROUP),
      "plan",
      "汇总中",
      `由「${brain.label}」合成最终答案…`,
      "started",
    );
    const synth = yield* this.runOnGen(input, brain, this.buildSynthPrompt(task, outputs), SYNTH_GROUP);
    const finalText = synth.text.trim() || this.renderFallbackSummary(outputs);
    yield makeEvent(this.finalInput(input), "message", "编排结果", finalText, "completed");
  }

  // -------------------------------------------------------------------------
  // 事件构造
  // -------------------------------------------------------------------------

  /** 结构化步骤状态事件（rawType=orchestrator.step，body 为 JSON）。 */
  private stepEvent(
    input: RunTurnInput,
    step: PlanStep,
    runner: RunnerOption,
    state: StepEventState,
    attempt: number,
    detail?: string,
  ): AgentEvent {
    const body = JSON.stringify({
      stepId: step.id,
      state,
      attempt,
      runnerId: runner.id,
      runnerLabel: runner.label,
      title: step.title,
      ...(detail ? { detail } : {}),
    });
    return makeEvent(
      this.groupInput(input, stepGroupId(step.id)),
      "dispatch",
      step.title,
      body,
      statusForState(state),
      STEP_RAW_TYPE,
    );
  }

  /** 人读派发事件（title「派发给 X」、body 含 instruction 全文），供 details 展开。 */
  private dispatchEvent(input: RunTurnInput, step: PlanStep, runner: RunnerOption): AgentEvent {
    return makeEvent(
      this.groupInput(input, stepGroupId(step.id)),
      "dispatch",
      `派发给 ${runner.label}`,
      `${step.title}\n\n${step.instruction}`,
      "started",
    );
  }

  // -------------------------------------------------------------------------
  // 计划解析 / 规范化
  // -------------------------------------------------------------------------

  private parsePlan(raw: string, candidates: RunnerOption[]): PlanStep[] {
    const jsonText = extractJsonArray(stripFences(raw));
    const parsed = safeJsonParse<unknown>(jsonText);
    if (!Array.isArray(parsed)) {
      return [];
    }
    const ids = new Set(candidates.map((option) => option.id));
    const brainId = candidates[0]!.id;

    // 第一趟：收集有效项 + LLM 原始 id
    type RawStep = {
      title: string;
      runnerId: string;
      instruction: string;
      rawDeps: string[];
      origId?: string;
    };
    const raws: RawStep[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const record = item as Record<string, unknown>;
      const instruction = typeof record.instruction === "string" ? record.instruction.trim() : "";
      if (!instruction) {
        continue;
      }
      const rawRunner = typeof record.runnerId === "string" ? record.runnerId.trim() : "";
      const runnerId = ids.has(rawRunner) ? rawRunner : brainId;
      const title =
        typeof record.title === "string" && record.title.trim() ? record.title.trim() : instruction.slice(0, 30);
      const origId = typeof record.id === "string" && record.id.trim() ? record.id.trim() : undefined;
      const rawDeps = Array.isArray(record.dependsOn)
        ? record.dependsOn.filter((dep): dep is string => typeof dep === "string").map((dep) => dep.trim())
        : [];
      raws.push({ title, runnerId, instruction, rawDeps, origId });
    }
    if (raws.length === 0) {
      return [];
    }

    // id 归一化：按序生成 s1/s2…，并建立「LLM 原始 id → 规范化 id」映射
    const norm = raws.map((_, index) => `s${index + 1}`);
    const origToNorm = new Map<string, string>();
    raws.forEach((rawStep, index) => {
      if (rawStep.origId) {
        origToNorm.set(rawStep.origId, norm[index]!);
      }
    });
    const normSet = new Set(norm);

    // 第二趟：翻译 dependsOn（原始 id / 规范化 id 皆可），丢弃未知与自引用
    const steps: PlanStep[] = raws.map((rawStep, index) => {
      const id = norm[index]!;
      const deps = new Set<string>();
      for (const dep of rawStep.rawDeps) {
        let target: string | undefined;
        if (origToNorm.has(dep)) {
          target = origToNorm.get(dep);
        } else if (normSet.has(dep)) {
          target = dep;
        }
        if (target && target !== id) {
          deps.add(target);
        }
      }
      return { id, title: rawStep.title, runnerId: rawStep.runnerId, instruction: rawStep.instruction, dependsOn: [...deps] };
    });

    return breakCycles(steps);
  }

  // -------------------------------------------------------------------------
  // Prompt / 渲染 / 上下文
  // -------------------------------------------------------------------------

  private buildPlanPrompt(task: string, candidates: RunnerOption[]): string {
    const list = candidates
      .map((option) => {
        const hint = option.capabilityHint ? `，能力：${option.capabilityHint}` : "";
        return `- id: ${option.id}（${option.label}${hint}）`;
      })
      .join("\n");
    return [
      "你是一个任务编排器。请把用户任务拆解成若干步骤，标注步骤间的依赖，并为每一步挑选最合适的执行体。",
      "",
      "可用执行体（runnerId 只能从下面这些 id 中选择）：",
      list,
      "",
      "用户任务：",
      task,
      "",
      "输出要求：",
      "- 只输出一个 JSON 数组，不要输出任何解释文字或 markdown 代码围栏。",
      '- 数组每一项形如 {"id":"s1","title":"简述","runnerId":"上面的某个id","instruction":"交给该执行体的具体指令","dependsOn":["s2"]}。',
      "- id 用 s1、s2… 递增；dependsOn 是本步依赖的其它步骤 id 数组，无依赖则为 []（可省略）。",
      "- 相互独立、能同时进行的步骤请让它们的 dependsOn 都为空，以便并行；有先后关系的才写依赖。",
      "- 若任务简单，可以只有一步。步骤之间应尽量避免重复劳动。",
    ].join("\n");
  }

  private buildSynthPrompt(task: string, outputs: StepOutput[]): string {
    const body = outputs
      .map(
        (output, index) =>
          `### 步骤${index + 1}：${output.title}（${output.label}）\n${truncate(output.text, SYNTH_CHARS_PER_STEP) || "（无输出）"}`,
      )
      .join("\n\n");
    return [
      "你是任务编排器。下面是针对用户任务，各子步骤执行体给出的产出。",
      "请综合这些产出，写出面向用户的最终完整答案（中文）。不要罗列步骤元信息，直接给结论。",
      "",
      "用户任务：",
      task,
      "",
      "各步骤产出：",
      body,
    ].join("\n");
  }

  /** 计划事件 body：version/task/steps[].{id,title,runnerId,runnerLabel,dependsOn}。 */
  private buildPlanJson(task: string, plan: PlanStep[], candidates: RunnerOption[]): string {
    const labelOf = (runnerId: string): string =>
      candidates.find((option) => option.id === runnerId)?.label ?? runnerId;
    return JSON.stringify({
      version: 1,
      task: task.slice(0, 200),
      steps: plan.map((step) => ({
        id: step.id,
        title: step.title,
        runnerId: step.runnerId,
        runnerLabel: labelOf(step.runnerId),
        dependsOn: step.dependsOn,
      })),
    });
  }

  private renderFallbackSummary(outputs: StepOutput[]): string {
    return outputs
      .map((output, index) => `## 步骤${index + 1}：${output.title}\n${output.text.trim() || "（无输出）"}`)
      .join("\n\n");
  }

  /** 全部 failed/skipped 时的如实说明。 */
  private renderAllFailed(plan: PlanStep[], states: Map<string, RunState>): string {
    const label = (state: RunState | undefined): string =>
      state === "failed" ? "失败" : state === "skipped" ? "已跳过" : "未完成";
    const lines = plan.map((step) => `- ${step.title}：${label(states.get(step.id))}`);
    return ["所有步骤均未产出有效结果，编排未能完成任务。", "", ...lines].join("\n");
  }

  /** 步骤 content = instruction + 其 dependsOn 步骤产出（每步截 2000、合计 8000，超限丢最早）。 */
  private buildStepContent(step: PlanStep, results: Map<string, StepOutput>): string {
    if (step.dependsOn.length === 0) {
      return step.instruction;
    }
    const blocks: string[] = [];
    for (const depId of step.dependsOn) {
      const output = results.get(depId);
      if (!output) {
        continue;
      }
      blocks.push(`【${output.title} · ${output.label}】\n${truncate(output.text, DEP_CHARS_PER_STEP)}`);
    }
    if (blocks.length === 0) {
      return step.instruction;
    }
    const { text, dropped } = capBlocks(blocks, DEP_CHARS_TOTAL);
    const header = dropped > 0 ? `[依赖步骤产出（已省略较早的 ${dropped} 个）]` : "[依赖步骤产出]";
    return `${step.instruction}\n\n${header}\n${text}`;
  }

  // -------------------------------------------------------------------------
  // 输入变体
  // -------------------------------------------------------------------------

  private orchInput(input: RunTurnInput): RunTurnInput {
    return { ...input, group: undefined, sourceLabel: ORCH_LABEL };
  }

  private groupInput(input: RunTurnInput, group: string): RunTurnInput {
    return { ...input, group, sourceLabel: ORCH_LABEL };
  }

  private finalInput(input: RunTurnInput): RunTurnInput {
    return { ...input, group: undefined, sourceLabel: ORCH_LABEL };
  }
}

// ---------------------------------------------------------------------------
// 合流队列：单消费者、多生产者的基于 Promise 的事件 fan-in
// ---------------------------------------------------------------------------

/**
 * 单消费者（fan-out 主循环）+ 多生产者（各 worker）的合流队列：worker push，
 * 主循环 await next()。有缓冲事件先出，close 后排空缓冲再返回 done。
 */
class Merger<T> {
  private readonly buffer: T[] = [];
  private waiting: ((result: IteratorResult<T>) => void) | null = null;
  closed = false;

  push(value: T): void {
    if (this.closed) {
      return;
    }
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value, done: false });
    } else {
      this.buffer.push(value);
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: undefined as never, done: true });
    }
  }

  next(): Promise<IteratorResult<T>> {
    if (this.buffer.length > 0) {
      return Promise.resolve({ value: this.buffer.shift()!, done: false });
    }
    if (this.closed) {
      return Promise.resolve({ value: undefined as never, done: true });
    }
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }
}

// ---------------------------------------------------------------------------
// 纯函数辅助
// ---------------------------------------------------------------------------

function stepGroupId(stepId: string): string {
  return `step-${stepId}`;
}

function statusForState(state: StepEventState): AgentEvent["status"] {
  switch (state) {
    case "running":
      return "started";
    case "retrying":
      return "updated";
    case "completed":
      return "completed";
    case "failed":
    case "skipped":
      return "failed";
  }
}

/**
 * 检测依赖成环则把成环步骤的 dependsOn 线性化为「前一步 id」保证可执行；
 * 极端情况下若仍成环，则全量线性化（每步依赖前一步）作为最终兜底。
 */
function breakCycles(steps: PlanStep[]): PlanStep[] {
  if (findCyclicNodes(steps).size === 0) {
    return steps;
  }
  const cyclic = findCyclicNodes(steps);
  const fixed = steps.map((step, index) => {
    if (!cyclic.has(step.id)) {
      return step;
    }
    const prev = index > 0 ? steps[index - 1]!.id : undefined;
    return { ...step, dependsOn: prev ? [prev] : [] };
  });
  if (findCyclicNodes(fixed).size === 0) {
    return fixed;
  }
  // 兜底：全量线性化
  return steps.map((step, index) => ({ ...step, dependsOn: index > 0 ? [steps[index - 1]!.id] : [] }));
}

/** Kahn 拓扑排序，返回无法被排出的节点（= 处于环上的节点）。 */
function findCyclicNodes(steps: PlanStep[]): Set<string> {
  const ids = new Set(steps.map((step) => step.id));
  const indegree = new Map<string, number>(steps.map((step) => [step.id, 0] as const));
  const adjacency = new Map<string, string[]>(steps.map((step) => [step.id, []] as const));
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (!ids.has(dep)) {
        continue;
      }
      indegree.set(step.id, (indegree.get(step.id) ?? 0) + 1);
      adjacency.get(dep)!.push(step.id);
    }
  }
  const queue = steps.filter((step) => (indegree.get(step.id) ?? 0) === 0).map((step) => step.id);
  const removed = new Set<string>();
  while (queue.length > 0) {
    const node = queue.shift()!;
    removed.add(node);
    for (const next of adjacency.get(node)!) {
      const left = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, left);
      if (left === 0) {
        queue.push(next);
      }
    }
  }
  const cyclic = new Set<string>();
  for (const step of steps) {
    if (!removed.has(step.id)) {
      cyclic.add(step.id);
    }
  }
  return cyclic;
}

/** 保留最新的若干块，使合计（含分隔）不超过 limit，返回丢弃的（最早的）块数。 */
function capBlocks(blocks: string[], limit: number): { text: string; dropped: number } {
  const kept: string[] = [];
  let total = 0;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const add = blocks[index]!.length + (kept.length > 0 ? 2 : 0);
    if (total + add > limit && kept.length > 0) {
      return { text: kept.join("\n\n"), dropped: index + 1 };
    }
    total += add;
    kept.unshift(blocks[index]!);
  }
  return { text: kept.join("\n\n"), dropped: 0 };
}

/** 剥离 ```json ... ``` 之类的 markdown 代码围栏。 */
function stripFences(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/);
  return (match ? match[1]! : trimmed).trim();
}

/** 从文本里抠出第一个 JSON 数组片段，容忍 LLM 前后夹带零碎文字。 */
function extractJsonArray(text: string): string {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start >= 0 && end > start) {
    return text.slice(start, end + 1);
  }
  return text;
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…（已截断）`;
}
