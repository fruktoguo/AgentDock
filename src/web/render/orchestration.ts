import { icon } from "../icons.js";
import type { AgentEvent } from "../types.js";
import { escapeHtml, formatUsageSummary } from "../utils.js";

/**
 * 编排看板的纯渲染逻辑（落地第 5 步前端）。
 *
 * 唯一事实源：docs/orchestration-protocol.md（§2 事件、§4 前端消费）。
 * 本模块只依赖 icons/utils/types（皆为纯模块，不触碰 document/window），
 * 故可被 node 直跑的冒烟测试单独 import。
 *
 * 数据源：
 *  - `orchestrator.plan` 事件（计划结构，取最新一条）
 *  - `orchestrator.step` 事件（步骤状态，同一 stepId 取最新一条）
 *  - 各 `step-<id>` 组的底层事件（事件计数 / token 用量）
 */

/** 计划事件 rawType（结构化，body 为 JSON）。 */
export const PLAN_RAW_TYPE = "orchestrator.plan";
/** 步骤状态事件 rawType（结构化，body 为 JSON）。 */
export const STEP_RAW_TYPE = "orchestrator.step";

/**
 * 是否为「结构化编排事件」（计划 / 步骤状态）。
 * 这两类事件不进 group details 的事件列表（避免 JSON 噪音），只喂给看板。
 */
export function isStructuredOrchestrationEvent(event: AgentEvent): boolean {
  return event.rawType === PLAN_RAW_TYPE || event.rawType === STEP_RAW_TYPE;
}

/** 步骤运行态（pending = 有计划但还没有任何 step 事件）。 */
export type StepState = "pending" | "running" | "retrying" | "completed" | "failed" | "skipped";

type PlanStep = {
  id: string;
  title: string;
  runnerId?: string;
  runnerLabel?: string;
  dependsOn: string[];
};

type StepStatus = {
  state: StepState;
  attempt: number;
  runnerLabel?: string;
  title?: string;
  detail?: string;
};

const STATE_LABEL: Record<StepState, string> = {
  pending: "待执行",
  running: "运行中",
  retrying: "重试中",
  completed: "已完成",
  failed: "失败",
  skipped: "已跳过",
};

const KNOWN_STATES = new Set<StepState>(["running", "retrying", "completed", "failed", "skipped"]);

/**
 * 渲染编排看板。返回空串表示「不出看板」：
 *  - 没有 `orchestrator.plan` 事件（旧会话 / 非编排模式）；
 *  - 或计划事件 body JSON 解析失败 / 无有效步骤（调用方据此回退纯文本 <pre>）。
 */
export function renderOrchestrationBoard(events: AgentEvent[]): string {
  const steps = parsePlan(events);
  if (!steps) {
    return "";
  }
  const statuses = collectLatestStepStatuses(events);
  const cards = steps.map((step) => renderStepCard(step, statuses.get(step.id), events)).join("");

  let completed = 0;
  let abnormal = 0;
  for (const step of steps) {
    const state = statuses.get(step.id)?.state ?? "pending";
    if (state === "completed") {
      completed += 1;
    } else if (state === "failed" || state === "skipped") {
      abnormal += 1;
    }
  }
  const meta = [`${steps.length} 步`, `完成 ${completed}/${steps.length}`];
  if (abnormal > 0) {
    meta.push(`异常 ${abnormal}`);
  }

  return `
    <section class="orch-board" data-orch-board>
      <div class="orch-head">
        ${icon("list")}
        <strong>编排看板</strong>
        <span class="orch-meta">${escapeHtml(meta.join(" · "))}</span>
      </div>
      <div class="orch-steps">
        ${cards}
      </div>
    </section>
  `;
}

/** 取最新一条 orchestrator.plan，解析出步骤数组；无事件或解析失败返回 null。 */
function parsePlan(events: AgentEvent[]): PlanStep[] | null {
  let planEvent: AgentEvent | undefined;
  for (const event of events) {
    if (event.rawType !== PLAN_RAW_TYPE) {
      continue;
    }
    if (!planEvent || event.createdAt >= planEvent.createdAt) {
      planEvent = event;
    }
  }
  if (!planEvent) {
    return null; // 无计划事件 → 旧会话，不出看板
  }

  const data = safeParseObject(planEvent.body);
  if (!data) {
    return null; // JSON 损坏 → 调用方回退 <pre>
  }
  const rawSteps = (data as { steps?: unknown }).steps;
  if (!Array.isArray(rawSteps)) {
    return null;
  }

  const steps: PlanStep[] = [];
  for (const raw of rawSteps) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const record = raw as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id) {
      continue;
    }
    steps.push({
      id,
      title: typeof record.title === "string" ? record.title : "",
      runnerId: typeof record.runnerId === "string" ? record.runnerId : undefined,
      runnerLabel: typeof record.runnerLabel === "string" ? record.runnerLabel : undefined,
      dependsOn: Array.isArray(record.dependsOn)
        ? record.dependsOn.filter((dep): dep is string => typeof dep === "string")
        : [],
    });
  }
  return steps.length > 0 ? steps : null;
}

/** 汇总每个 stepId 最新一条 orchestrator.step 的状态。损坏的单条事件跳过，不影响其余。 */
function collectLatestStepStatuses(events: AgentEvent[]): Map<string, StepStatus> {
  const latest = new Map<string, { status: StepStatus; createdAt: string }>();
  for (const event of events) {
    if (event.rawType !== STEP_RAW_TYPE) {
      continue;
    }
    const data = safeParseObject(event.body);
    if (!data) {
      continue;
    }
    const stepId = typeof data.stepId === "string" ? data.stepId : "";
    if (!stepId) {
      continue;
    }
    const rawState = typeof data.state === "string" ? (data.state as StepState) : "running";
    const state: StepState = KNOWN_STATES.has(rawState) ? rawState : "running";
    const status: StepStatus = {
      state,
      attempt: typeof data.attempt === "number" && Number.isFinite(data.attempt) ? data.attempt : 1,
      runnerLabel: typeof data.runnerLabel === "string" ? data.runnerLabel : undefined,
      title: typeof data.title === "string" ? data.title : undefined,
      detail: typeof data.detail === "string" ? data.detail : undefined,
    };
    const existing = latest.get(stepId);
    if (!existing || event.createdAt >= existing.createdAt) {
      latest.set(stepId, { status, createdAt: event.createdAt });
    }
  }
  const out = new Map<string, StepStatus>();
  for (const [id, entry] of latest) {
    out.set(id, entry.status);
  }
  return out;
}

function renderStepCard(step: PlanStep, status: StepStatus | undefined, events: AgentEvent[]): string {
  const state: StepState = status?.state ?? "pending";
  const stateLabel = STATE_LABEL[state];
  const runner = status?.runnerLabel ?? step.runnerLabel ?? step.runnerId ?? "";
  const title = status?.title ?? step.title ?? step.id;
  const attempt = status?.attempt ?? 1;

  // 底层事件（排除结构化 JSON）：事件计数 + token 用量。
  const groupId = `step-${step.id}`;
  const groupEvents = events.filter((event) => event.group === groupId && !isStructuredOrchestrationEvent(event));
  const hasDetails = groupEvents.length > 0;
  const usage = formatUsageSummary(groupEvents);
  const usageText = [groupEvents.length > 0 ? `${groupEvents.length} 个事件` : "", usage]
    .filter(Boolean)
    .join(" · ");

  const depTags = step.dependsOn
    .map((dep) => `<span class="orch-dep" title="依赖步骤 ${escapeHtml(dep)}">← ${escapeHtml(dep)}</span>`)
    .join("");
  // attempt > 1：标注重试（换人由 runnerLabel 体现——当前 runner 即换后的执行体）。
  const attemptTag = attempt > 1 ? `<span class="orch-attempt" title="第 ${attempt} 次尝试">↻ 第 ${attempt} 次</span>` : "";
  const usageTag = usageText ? `<span class="orch-usage">${escapeHtml(usageText)}</span>` : "";
  const footInner = `${depTags}${attemptTag}${usageTag}`;

  const detailLine = status?.detail ? `<div class="orch-step-detail">${escapeHtml(status.detail)}</div>` : "";

  // 有底层事件才可点开对应 step details（走事件委托 data-action，见 events.ts）。
  const clickAttrs = hasDetails ? ` data-action="toggle-step" data-details-target="sub:${escapeHtml(groupId)}"` : "";
  const clickClass = hasDetails ? " is-clickable" : "";

  return `
    <article class="orch-step orch-step--${state}${clickClass}"${clickAttrs}>
      <div class="orch-step-top">
        <span class="orch-step-id">${escapeHtml(step.id)}</span>
        <span class="orch-state orch-state--${state}">${escapeHtml(stateLabel)}</span>
        ${runner ? `<span class="orch-runner" title="${escapeHtml(runner)}">${escapeHtml(runner)}</span>` : ""}
      </div>
      <div class="orch-step-title">${escapeHtml(title)}</div>
      ${footInner ? `<div class="orch-step-foot">${footInner}</div>` : ""}
      ${detailLine}
    </article>
  `;
}

/** JSON.parse 成对象则返回，否则返回 null（容忍损坏 body，不抛错）。 */
function safeParseObject(body: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}
