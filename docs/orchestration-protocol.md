# 编排协议 v1（落地第 5 步契约）

> 本文是编排器（后端）与可视化看板（前端）之间的**事件契约**。两侧实现以本文为准；
> 字段增删必须先改本文。对应 requirements.md §5 / §8 / §10.5。

## 0. 范围

落地第 5 步 = 并行 fan-out + 上下文交接 + 策略兜底（后端）与编排可视化看板 + 移动端自适应（前端）。
两侧只通过既有 `AgentEvent` 流耦合：后端新增两种**结构化事件**（`rawType` 区分，`body` 为 JSON），
前端解析渲染；解析失败必须回退为现状的纯文本展示（向后兼容旧会话数据）。

## 1. 计划结构（后端内部 + 计划事件 payload）

```ts
// orchestrator.ts 内部
type PlanStep = {
  id: string;           // 标准化为 "s1"、"s2"…（LLM 给的 id 归一化；缺失则按序生成）
  title: string;
  runnerId: string;     // 必须是候选 runner id，否则回退 brain
  instruction: string;  // 不进看板 JSON（过长），派发人读事件里可见
  dependsOn: string[];  // 依赖步骤 id；空数组 = 可立即执行
};

type OrchestrationPolicy = {
  maxConcurrency: number; // 默认 3
  maxAttempts: number;    // 每步最多尝试次数，默认 2（首跑 + 1 次重试/换人）
};
```

规划 prompt 要求 LLM 输出 JSON 数组，每项：
`{"id":"s1","title":"…","runnerId":"…","instruction":"…","dependsOn":["s2",…]}`
（`dependsOn` 可省略 = `[]`。）

**依赖校验**：未知 id 的依赖直接丢弃；拓扑检测到环时，成环各步的 `dependsOn`
回退为 `[前一步 id]`（按数组顺序线性化），保证可执行。

## 2. 事件协议

沿用 `AgentEvent`，不加新字段、不加新 kind。新增两种 `rawType`：

### 2.1 计划事件 `orchestrator.plan`

规划完成时发一条：
`kind:"plan"`, `rawType:"orchestrator.plan"`, `group:"plan"`, `status:"completed"`,
`title:"规划完成"`, `source:"编排 Agent"`，**body 为 JSON**：

```json
{
  "version": 1,
  "task": "用户任务原文（截 200 字符）",
  "steps": [
    { "id": "s1", "title": "…", "runnerId": "cli:codex",  "runnerLabel": "Codex CLI",  "dependsOn": [] },
    { "id": "s2", "title": "…", "runnerId": "cli:claude", "runnerLabel": "Claude Code", "dependsOn": ["s1"] }
  ]
}
```

规划开始的人读事件（`"规划任务"`, started, 纯文本）照旧保留。

### 2.2 步骤状态事件 `orchestrator.step`

每次步骤状态变化发一条：
`kind:"dispatch"`, `rawType:"orchestrator.step"`, `group:"step-<stepId>"`（如 `step-s1`），
`source:"编排 Agent"`，**body 为 JSON**：

```json
{
  "stepId": "s1",
  "state": "running",
  "attempt": 1,
  "runnerId": "cli:codex",
  "runnerLabel": "Codex CLI",
  "title": "步骤标题",
  "detail": "可选的人读补充（失败原因 / 换人说明 / 跳过原因）"
}
```

`state` 取值与 `status` 映射：

| state       | 含义                         | AgentEvent.status |
|-------------|------------------------------|-------------------|
| `running`   | 开始执行（每次 attempt 都发）| `started`         |
| `retrying`  | 失败后将重试（含换人信息）   | `updated`         |
| `completed` | 成功                         | `completed`       |
| `failed`    | 尝试次数耗尽                 | `failed`          |
| `skipped`   | 依赖失败/中止而跳过          | `failed`          |

### 2.3 保持不变的部分

- 子任务底层事件照旧带 `group:"step-<stepId>"` + `source:<runnerLabel>`（现有回填机制）。**回填按字段独立判断**：事件缺 `group` 就补步骤组，缺 `source` 就补执行体名——即使某第三方 driver 只报了 `source` 却不带 `group`，其 completed message 也会被补上 `group`，绝不漏成无 `group` 的游离 assistant 气泡（守住「最终唯一无 group message」不变量）。
- 派发时的人读 dispatch 事件（`title:"派发给 X"`，body 含 instruction 全文）保留，供 details 展开查看。
- 最终合成仍是**唯一一条无 group 的 completed message**（assistant 气泡规则不变）。
- group id 由 `step-<index>` 改为 `step-<stepId>`，前端不得依赖数字次序。

## 3. 调度语义（后端实现要求）

- **就绪驱动**：`dependsOn` 全部 completed 即入队；并发上限 `maxConcurrency`，事件经合流队列按到达序 yield（禁止等全部完成再统一吐事件）。
- **重试/换人**：attempt 失败（抛错或产出空文本视为失败）→ 若 attempt < maxAttempts，换一个可用 runner 重试（优先 brain，且尽量不同于刚失败者；无他选则原 runner 重跑），发 `retrying`；否则 `failed`。
- **跳过**：依赖中出现 failed/skipped → 本步直接 `skipped`（detail 注明因哪步）。
- **中止**：外层 AbortSignal 触发后不再派发新步骤，未启动的步骤发 `skipped`（detail："已中止"）；**正在执行**的步骤被中止后同样记为 `skipped`「已中止」（而非 `failed`——`failed` 专指尝试次数耗尽，见 §2.2），保证同一次中止里所有受影响步骤语义一致、且不把子驱动的原始中止错误串透传到卡片。
- **上下文交接**：步骤 content = instruction + 其 `dependsOn` 步骤的产出，每步截 2000 字符、合计上限 8000（超限从最早的开始丢并注明），标注来源（`步骤标题 · runnerLabel`）。无依赖则不注入。合成 prompt 拿全部产出，每步截 6000。
- **兜底**：候选为空报错（现状）；plan 解析为空回退单步 `{id:"s1", dependsOn:[]}` 直接执行（现状 + 补字段）；全部步骤 failed/skipped 时合成阶段如实说明。

## 4. 前端消费（实现要求）

- 看板数据源：`orchestrator.plan` 事件（结构）+ `orchestrator.step` 事件（状态，同一 stepId 取**最新**一条）+ 各 `step-<id>` 组的底层事件（计数 / token 用量）。
- 两种结构化事件**不进** group details 的事件列表（按 rawType 过滤，避免 JSON 噪音）；人读 dispatch / 子任务事件照旧进 details。
- 步骤卡片状态：`pending`（无 step 事件）/ `running` / `retrying` / `completed` / `failed` / `skipped`；attempt > 1 标注重试与换人；`dependsOn` 以"← s1"式小标签展示。
- 点击卡片 toggle 对应 `step-<id>` 的 details 展开（走现有事件委托，`data-action`）。
- 渲染必须走现有 `paintTimeline` 增量管线（rAF 合帧 + details 展开态保留），**不得**引入独立全量重绘。
- `body` JSON 解析失败 → 回退现状纯文本渲染（`<pre>`），不得报错或空白。
- 旧会话（无结构化事件）走现状渲染路径，不出看板。

## 5. 验收

- 后端：`src/agentdock/runtime/orchestrator-smoke.ts` 用 mock registry/driver 覆盖 15 个用例——
  并行时序重叠、依赖上下文注入、**多依赖上下文截断（每依赖 2000 / 合计 8000 丢最早并注明）**、
  重试换人、**空文本产出判失败**、依赖失败链式跳过、并发上限=1 退化串行、
  事件完整性（每步有 step 事件、plan JSON 可解析、最终 message 唯一且无 group）、
  **中止（串行 abort 不再派发 + 并行 in-flight abort 记 skipped 而非 failed）**、
  **source-only 子事件 group 回填不漏气泡**、**成环计划线性化不死锁**、
  **LLM 原始 id 归一化 + dependsOn 翻译**、**空计划单步兜底**、**无可用执行体报错**、
  **未知/自引用依赖丢弃**。
- 前端：`src/web/render/timeline-smoke.ts`（node 直跑，不 import app.js/DOM）——
  含结构化事件的假 session 渲出各状态卡片与依赖标签；**换人在 s3 卡片作用域内断言换后 runner**；
  结构化事件隔离出 details；JSON 损坏回退 `<pre>`；旧数据无看板。
- 全量：`npm run build` 零错误，native 下 6 个既有 smoke 全部 PASS。

## 6. 已知次要项（不阻塞，后续打磨）

- 编排器自身的「规划」(group `plan`) 与「合成」(group `synthesis`) 阶段的**底层事件**
  （主脑的 lifecycle/reasoning/usage）会被前端归入普通子任务桶并冠以「派发给 编排 Agent」
  的分隔头。这两阶段并非任务派发、且已另有规划/汇总 plan-card 表示，属呈现语义不精确的表层瑕疵
  （非契约字段级违规、不影响数据/功能）。修法涉及"丢弃 vs 改用非派发表头"的呈现取舍，留待前端打磨。
