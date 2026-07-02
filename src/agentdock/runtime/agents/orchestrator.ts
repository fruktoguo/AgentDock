import { makeEvent, safeJsonParse } from "../../adapters/shared.js";
import type { DriverRegistry } from "../driver-registry.js";
import type { AgentDriver, AgentEvent, RunTurnInput, RunnerOption } from "../types.js";

type ListRunners = () => Promise<RunnerOption[]>;

type PlanStep = {
  title: string;
  runnerId: string;
  instruction: string;
};

type StepOutput = {
  title: string;
  label: string;
  text: string;
};

const ORCH_LABEL = "编排 Agent";
const PLAN_GROUP = "plan";
const SYNTH_GROUP = "synthesis";

/**
 * 编排 Agent：先让"主脑"（第一个可用 runner）产出 JSON 计划，
 * 再把每个步骤串行派发给最合适的 runner，最后合成最终答案。
 * 子任务事件都带 group + sourceLabel，便于前端分组可视化；
 * 只有最终合成消息不带 group，从而成为唯一的 assistant 气泡。
 */
export class OrchestratorDriver implements AgentDriver {
  constructor(
    private readonly registry: DriverRegistry,
    private readonly listRunners: ListRunners,
  ) {}

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

    // b. 规划
    yield makeEvent(this.groupInput(input, PLAN_GROUP), "plan", "规划任务", `由「${brain.label}」拆解任务…`, "started");
    const planText = yield* this.runOn(input, brain, this.buildPlanPrompt(task, candidates), PLAN_GROUP);
    let plan = this.parsePlan(planText, candidates);
    if (plan.length === 0) {
      plan = [{ title: "直接执行", runnerId: brain.id, instruction: task }];
    }
    yield makeEvent(
      this.groupInput(input, PLAN_GROUP),
      "plan",
      "规划完成",
      this.renderPlan(plan, candidates),
      "completed",
    );

    // c. 串行执行
    const outputs: StepOutput[] = [];
    for (let index = 0; index < plan.length; index += 1) {
      const step = plan[index]!;
      const stepGroup = `step-${index + 1}`;
      const target = candidates.find((option) => option.id === step.runnerId) ?? brain;

      yield makeEvent(
        this.groupInput(input, stepGroup),
        "dispatch",
        `派发给 ${target.label}`,
        `${step.title}\n\n${step.instruction}`,
        "started",
      );

      const context = this.buildContext(outputs);
      const content = context ? `${step.instruction}\n\n[前序步骤产出（供参考）]\n${context}` : step.instruction;
      const text = yield* this.runOn(input, target, content, stepGroup);
      outputs.push({ title: step.title, label: target.label, text });
    }

    // d. 收口 / 合成
    if (outputs.length === 1) {
      const finalText = outputs[0]!.text.trim() || "（子任务没有返回文本。）";
      yield makeEvent(this.finalInput(input), "message", "编排结果", finalText, "completed");
      return;
    }

    yield makeEvent(this.groupInput(input, SYNTH_GROUP), "plan", "汇总中", `由「${brain.label}」合成最终答案…`, "started");
    const synthText = yield* this.runOn(input, brain, this.buildSynthPrompt(task, outputs), SYNTH_GROUP);
    const finalText = synthText.trim() || this.renderFallbackSummary(outputs);
    yield makeEvent(this.finalInput(input), "message", "编排结果", finalText, "completed");
  }

  /** 用指定 runner 跑一段内容，透传其事件（已打好 group/source），返回其 completed message 文本。 */
  private async *runOn(
    outerInput: RunTurnInput,
    option: RunnerOption,
    content: string,
    group: string,
  ): AsyncGenerator<AgentEvent, string> {
    const resolved = this.registry.resolve(option.ref);
    if (!resolved.driver) {
      yield makeEvent(
        { ...outerInput, group, sourceLabel: option.label },
        "error",
        `无法运行 ${option.label}`,
        resolved.error ?? "未知错误",
        "failed",
      );
      return "";
    }

    const subInput: RunTurnInput = {
      session: outerInput.session,
      content,
      runner: option.ref,
      provider: resolved.provider,
      model: option.ref.kind === "api" ? option.ref.model : undefined,
      signal: outerInput.signal,
      group,
      sourceLabel: option.label,
    };

    let text = "";
    try {
      for await (const event of resolved.driver.runTurn(subInput)) {
        // 有的 driver（如 codex）不读 input.group/sourceLabel，用自己的构造器发事件，
        // 这里回填 group/source，保证子任务事件能在前端归组、标注来源。
        const stamped: AgentEvent =
          event.group === undefined && event.source === undefined
            ? { ...event, group, source: option.label }
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
        error instanceof Error ? error.message : String(error),
        "failed",
      );
    }
    return text;
  }

  private parsePlan(raw: string, candidates: RunnerOption[]): PlanStep[] {
    const ids = new Set(candidates.map((option) => option.id));
    const jsonText = extractJsonArray(stripFences(raw));
    const parsed = safeJsonParse<unknown>(jsonText);
    if (!Array.isArray(parsed)) {
      return [];
    }
    const steps: PlanStep[] = [];
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
      const runnerId = ids.has(rawRunner) ? rawRunner : candidates[0]!.id;
      const title =
        typeof record.title === "string" && record.title.trim()
          ? record.title.trim()
          : instruction.slice(0, 30);
      steps.push({ title, runnerId, instruction });
    }
    return steps;
  }

  private buildPlanPrompt(task: string, candidates: RunnerOption[]): string {
    const list = candidates
      .map((option) => {
        const hint = option.capabilityHint ? `，能力：${option.capabilityHint}` : "";
        return `- id: ${option.id}（${option.label}${hint}）`;
      })
      .join("\n");
    return [
      "你是一个任务编排器。请把用户任务拆解成有序步骤，并为每一步挑选最合适的执行体。",
      "",
      "可用执行体（runnerId 只能从下面这些 id 中选择）：",
      list,
      "",
      "用户任务：",
      task,
      "",
      "输出要求：",
      '- 只输出一个 JSON 数组，不要输出任何解释文字或 markdown 代码围栏。',
      '- 数组每一项形如 {"title": "简述", "runnerId": "上面的某个id", "instruction": "交给该执行体的具体指令"}。',
      "- 若任务简单，可以只有一步。步骤之间应尽量避免重复劳动。",
    ].join("\n");
  }

  private buildSynthPrompt(task: string, outputs: StepOutput[]): string {
    const body = outputs
      .map((output, index) => `### 步骤${index + 1}：${output.title}（${output.label}）\n${output.text.trim() || "（无输出）"}`)
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

  private renderPlan(plan: PlanStep[], candidates: RunnerOption[]): string {
    return plan
      .map((step, index) => {
        const target = candidates.find((option) => option.id === step.runnerId);
        return `${index + 1}. [${target?.label ?? step.runnerId}] ${step.title}`;
      })
      .join("\n");
  }

  private renderFallbackSummary(outputs: StepOutput[]): string {
    return outputs
      .map((output, index) => `## 步骤${index + 1}：${output.title}\n${output.text.trim() || "（无输出）"}`)
      .join("\n\n");
  }

  private buildContext(outputs: StepOutput[]): string {
    return outputs
      .map((output, index) => `步骤${index + 1}（${output.title}）：${truncate(output.text, 400)}`)
      .join("\n");
  }

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
