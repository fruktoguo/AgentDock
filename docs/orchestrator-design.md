# AgentDock 编排 Agent 设计稿

> 本文承接 `architecture.md`，聚焦「一个能调度各家 Agent 的主 Agent」这一核心目标，
> 敲定三件会锁死接口的事：**① 统一 subagent 接口（CLI/API 双后端）② provider 配置模型 ③ 能力画像与路由决策**。

## 1. 目标与定位

做一个**本身就具备完整编码能力**的主 Agent（编排大脑），它按「各家模型的公认强项」把大任务拆解、分派给最合适的子 Agent 协同完成。

关键取向：**扬长避短、分工协作**，而不是把同一任务发给多家再投票择优（冗余对抗）。

主 Agent 驱动子 Agent 有两条路：

- **CLI 后端**：直接驱动本机现成的 Claude Code / Codex CLI，白嫖其订阅额度与整套工具/文件/权限能力；
- **API 后端（供应商模式）**：直接配 provider + key，打模型 API（OpenAI / Anthropic / Google / DeepSeek / Grok / 自定义兼容网关）。

主 Agent 自己下场编码时，也是一次 LLM 调用，因此**它自身也要一个"脑子模型"**，同样走 provider 配置。

### 与现状的关系

当前仓库已有：统一事件模型（`AgentEvent`）、`AgentDriver` 接口、Codex 的 API 后端（`codex-driver`）、本地持久化、Web 原型。
本设计要补齐的空占位目录：`runtime/agents`（编排大脑）、`runtime/subagents`（子任务调度与上下文交接）、`runtime/tools`（把"调用 subagent"变成工具）、`runtime/policies`（路由/预算/重试）、`config`（provider）、`adapters/claude`（第二个真实后端）。

## 2. 分层总览

```
┌──────────────────────────────────────────────────────────┐
│ Orchestrator Agent（编排大脑，runtime/agents）              │
│  · plan：理解任务 → 拆解为子任务 DAG                         │
│  · route：为每个子任务选 (capability → agent + backend)      │
│  · dispatch：作为 tool-call 调用 subagent                   │
│  · collect：消费子 Agent 事件流 → 判断验收/返工/合并          │
│  · 也可"自己干"：直接用自身脑子模型编码                        │
└───────────────┬──────────────────────────────────────────┘
                │ callSubagent(task) —— 一个注册在编排大脑上的 tool
                ▼
┌──────────────────────────────────────────────────────────┐
│ Subagent 调度层（runtime/subagents）                        │
│  · 父子任务关系、取消、超时、预算下发                          │
│  · 上下文打包（把上游产出裁剪成下游能吃的输入）                 │
│  · 子 Agent 事件流 → 归并成父任务可消费的结构化结果            │
└───────────────┬──────────────────────────────────────────┘
                │ AgentDriver.runTurn(input) → AsyncGenerator<AgentEvent>
      ┌─────────┴───────────────┐
      ▼                         ▼
┌──────────────────┐   ┌──────────────────────────────┐
│ CLI 后端          │   │ API 后端（供应商模式）           │
│ adapters/*/cli    │   │ adapters/*/sdk                │
│ · spawn `claude`  │   │ · Provider 注册表（config）     │
│ · spawn `codex`   │   │ · OpenAI/Anthropic/Google/     │
│ · 解析其 stream   │   │   DeepSeek/Grok/兼容网关        │
└──────────────────┘   └──────────────────────────────┘
```

## 3. 决策一：统一 subagent 接口（CLI/API 双后端）

沿用现有 `AgentDriver`，不新造边界。所有子 Agent —— 无论 CLI 还是 API —— 都实现同一个接口，向上只吐统一的 `AgentEvent` 流。

```ts
// 已存在于 runtime/types.ts，本设计沿用并扩展 RunTurnInput
export type AgentDriver = {
  runTurn(input: RunTurnInput): AsyncGenerator<AgentEvent>;
};
```

### 一个 Agent = (身份, 后端) 的组合

同一个模型可能有两种接法。把"选谁"和"怎么接"解耦：

```ts
export type Backend = "cli" | "api";

export type AgentBinding = {
  agent: AgentId;          // claude | codex | gemini | deepseek | grok | ...
  backend: Backend;        // cli=驱动本机 CLI；api=打供应商接口
  provider?: string;       // backend=api 时指向 config 里的 provider
  model?: string;          // 具体模型；不填由 driver 取默认
};
```

- `claude + cli` → 驱动 Claude Code；`claude + api` → 打 Anthropic API。
- `codex + cli` → Codex CLI；`codex + api` → 现有 `codex-driver`（`@openai/codex-sdk`）。
- `gemini/deepseek/grok + api` → 走各自 provider（多数 OpenAI 兼容）。

### 两种后端的实现要点

| | CLI 后端 | API 后端 |
|---|---|---|
| 驱动方式 | `spawn` 子进程，走它的流式协议（stream-json / 事件） | provider SDK / HTTP，自己驱动工具循环 |
| 工具/文件能力 | CLI 自带 | 需要 runtime 提供（`runtime/tools`），或纯文本对话 |
| 可用性探测 | 二进制在？已登录？（复用 server 的环境检测） | key/base_url 连通性 |
| 取消 | kill 进程 | `AbortSignal` 传入 SDK |
| 参考 | omnigent `*_native_executor.py` | omnigent `*_executor.py` / 现有 codex-driver |

> 落地顺序：先补 `claude + cli`（白嫖订阅、能力最完整、验证编排闭环最快），API 后端随 provider 一起做。

## 4. 决策二：Provider 配置模型

> 已按 `requirements.md` §4 定稿：**支持三种 wire format**——OpenAI Chat Completions（老）、OpenAI Responses（新）、Anthropic Messages。三种基本覆盖所有主流模型。

新增 `config` 层，服务两类消费者：(a) 主 Agent 自身脑子模型，(b) 所有 `backend=api` 的子 Agent。

```ts
export type ProviderConfig = {
  id: string;                        // 用户自定义标识，如 "openai" | "deepseek" | "my-claude-gateway"
  format: "openai-chat" | "openai-responses" | "anthropic";
  baseUrl?: string;                  // 自定义/兼容端点；不填用官方默认
  apiKeyEnv?: string;                // 优先从环境变量取，不落盘
  apiKey?: string;                   // 兜底：显式配置，持久化需脱敏展示
  models: string[];                  // 该 provider 暴露的模型
};
```

- **凭证优先走环境变量**（`apiKeyEnv`），显式 `apiKey` 仅作兜底，展示时脱敏；持久化沿用 `~/.ad/agentdock/`（可用 `AGENTDOCK_HOME` 覆盖）。
- **三种格式覆盖**：DeepSeek/Grok/Gemini 等第三方走各自兼容端点 + 对应 format（多为 `openai-chat`）接入，不为每家单独写 driver。
- provider 与 AgentBinding 通过 `provider` 字段关联；一个 provider 可被多个 binding 复用。

## 5. 决策三：能力画像与路由决策

路由的对象是**能力**，不是"某个具体 Agent"——因为同一模型 CLI/API 两种身份都能提供能力，且各家强项会随版本漂移。

### 能力画像（静态种子 + 可覆盖）

先用一张**可配置的静态表**做种子（避免过度设计），后续允许用户/编排器覆盖：

```ts
export type Capability =
  | "planning" | "architecture" | "frontend" | "ui-prototype"
  | "backend" | "impl" | "debugging" | "review" | "writing";

export type AgentProfile = {
  binding: AgentBinding;
  strengths: Capability[];    // 公认强项（种子值，可编辑）
  available: boolean;         // 由可用性探测填充
  notes?: string;
};
```

种子示例（基于当前公认表现，**明确标注会过时、可编辑**）：

| Agent | strengths（种子） |
|---|---|
| claude | planning, architecture, frontend, review, writing |
| codex(gpt) | impl, backend, debugging |
| gemini | ui-prototype, frontend |
| deepseek | impl, backend |
| grok | debugging, impl |

### 路由决策：LLM 判断（已定稿）

> 按 `requirements.md` §5：**不做静态表作为主决策**，能力匹配由 LLM 在分发 subagent 时判断。

1. **LLM 决策（主）**：分发子任务时，主 Agent 读到"当前所有可用可选项 + 每项的简短能力提示"，由 LLM 根据子任务内容自己判断派给哪个 binding。能跟上各家能力随版本漂移，无需维护映射表。上面的 `AgentProfile.strengths` 仅作为**给 LLM 的参考提示**，不是硬映射。
2. **策略兜底（`runtime/policies`）**：预算/并发上限、失败重试或换人、无可用 Agent 时回退给主 Agent 自己干。

## 6. 协作形态

- **串行委派**：主 Agent 一次派一个，拿结果再决定下一步 —— 先跑通这个。
- **并行 fan-out**：可并行的独立子任务同时派给不同 Agent，再汇总 —— 接口层用 `AsyncGenerator` 已天然支持，`subagents` 层做并发与归并。

典型流水（"做一个网站"）：
`claude(plan/拆解)` → `gemini(前端原型)` → `claude(前端工程化)` → `codex(后端+接口)` → `codex(修 bug)` → 主 Agent(验收/合并/交付)。

## 7. 上下文交接（multi-agent 最易崩的点）

各子 Agent 上下文互不相通，交接必须显式。`subagents` 层负责：

- **打包上游产出**：把上一步的关键产出（文件 diff、方案要点、接口契约）裁剪成下游 Agent 的输入，而非把整段历史塞过去；
- **共享工作区**：CLI 后端天然共享 `AGENTDOCK_WORKSPACE` 文件系统，产出通过文件落地传递；API 后端需把相关文件内容显式注入 prompt；
- **结构化回传**：子 Agent 的 `AgentEvent` 流归并成 `{产出摘要, 改动文件, 状态, 用量}` 交给主 Agent 验收。

## 8. 落地顺序（建议）

1. **补 `claude + cli` driver**：让底层从"只有 Codex"变成"Codex + Claude 都能当 subagent"，并接入现有环境检测。
2. **Provider 配置层 + API 后端骨架**：`config` 模型 + 至少一个 OpenAI 兼容 driver，主 Agent 脑子模型可配置。
3. **编排大脑最小闭环**：`runtime/agents` 里做一个能"拆解 → 用 tool 调 subagent → 收口"的主 Agent，先支持串行委派 + 静态能力匹配。
4. **上下文交接 + 并行 fan-out + 策略兜底**：逐步加。

## 9. 已定稿的选型（见 requirements.md）

- 能力匹配：**LLM 在分发 subagent 时判断**（不做静态表主决策）。
- Provider：**支持 openai-chat / openai-responses / anthropic 三种 format**。
- 语言：**全 TS**，omnigent 仅作思路参考、用 TS 重写，不接 Python。
- 运行模式：**手动（下拉框选可选项）+ 自动编排** 两种并存。

仍待你拍板（见 `requirements.md` §11）：主 Agent 脑子模型默认 binding、远程访问安全是否本期做、移动端编排可视化的退化方式。
