# AgentDock 需求细化

> 本文是 AgentDock 编排 Agent 的**权威需求说明**，在若干点上覆盖 `orchestrator-design.md` 的早期默认值（provider 种类、能力匹配方式、语言选型等以本文为准）。
> 架构分层与接口见 `architecture.md` / `orchestrator-design.md`。

## 1. 一句话定位

一个**自定义的、支持 Agent 编排的 Agent**：它自己就有完整的编码能力，同时能把其它 Agent（Claude Code / Codex / 各家 API 模型）的能力**同时发挥出来**——按任务分工协作，扬长避短。

对外形态是一个 **Web 应用**，可通过 frp 内网穿透，用手机或其它设备远程访问来开发。

## 2. 两种运行模式（都要）

### 2.1 手动模式（沿用现有下拉框）

用户在 composer 的下拉框里**手动指定**这一轮/这个会话用哪个 Agent。下拉框统一列出**所有已配置的可选项**：

- 已安装/已登录的 **CLI Agent**（Claude Code、Codex …）；
- 用户**自己配置的 API**（任意 provider + 模型，见 §4）。

也就是说：所有"可选项"——不管来自 CLI 还是自配 API——都出现在同一个下拉列表里，用户点一下就选定。这是当前已有交互的延续，保留并打磨。

### 2.2 自动编排模式（新增，核心价值）

选择"编排 Agent"这一项时，主 Agent 接管：它理解任务 → 拆解 → **在分发子任务（subagent）的那一刻，由 LLM 自己判断该把这个子任务交给哪个 Agent**，然后驱动子 Agent 执行、收口、合并、交付。

> 两种模式共用同一套后端 driver 与事件流；区别只是"谁来决定派给谁"——人（下拉框）还是主 Agent（LLM）。

## 3. Agent 来源与后端

一个"可选项" = `(agent 身份, 后端类型, 可选 provider/model)`。后端有两类：

- **CLI 后端**：`spawn` 本机已装且已登录的 CLI（Claude Code / Codex），白嫖订阅额度、复用其整套工具/文件/权限能力。
- **API 后端**：直接打模型 API，凭证与端点由用户自配（见 §4）。

同一个模型可能两种身份都在：例如 Claude 既能走 Claude Code（CLI），也能走 Anthropic API。两者都会作为独立可选项出现在下拉框里。

## 4. Provider（支持三种 wire format）

**API 后端支持三种协议格式，这三种基本覆盖所有主流模型：**

1. **OpenAI Chat Completions 格式**（老格式，`/v1/chat/completions`）—— DeepSeek、Grok、Gemini 兼容端点等多数第三方走这个；
2. **OpenAI Responses 格式**（新格式，`/v1/responses`）；
3. **Anthropic Messages 格式**（Claude 家标准 API）。

配置模型：

```ts
export type ProviderConfig = {
  id: string;                        // 用户自定义标识，如 "openai" | "deepseek" | "my-claude-gateway"
  format: "openai-chat" | "openai-responses" | "anthropic";
  baseUrl?: string;                  // 自定义/兼容端点；不填用官方默认
  apiKeyEnv?: string;                // 优先从环境变量取密钥
  apiKey?: string;                   // 兜底：显式配置，持久化需脱敏展示
  models: string[];                  // 该 provider 暴露给下拉框的模型
};
```

用户"自己接 API" = 填一个 `format + baseUrl + key + models`。第三方模型（DeepSeek/Grok/Gemini…）通过其兼容端点 + 对应 format 接入，无需为每家单独写 driver。

Provider 同时服务：(a) 主编排 Agent 自身的"脑子模型"，(b) 所有 API 后端子 Agent。

**脑子模型不单独指定**：默认取下拉框里第一个可选项即可，反正都是手动选的。

## 5. 能力匹配 = LLM 在分发时判断

**不做静态能力路由表作为主决策**。分发子任务（subagent）时，主 Agent 读到"当前所有可用可选项"，由 **LLM 根据子任务内容自己判断**派给哪个 Agent。

- 可以在 prompt 里给每个可选项附**简短能力提示**（如 "Claude：规划/前端强；Codex：代码实现强；Gemini：UI 原型强"）作为参考，但最终由 LLM 决策，不是硬映射。
- 好处：能跟上各家能力随版本漂移，无需人工维护映射表。
- `runtime/policies` 只保留**兜底约束**：预算/并发上限、失败重试或换人、无可用 Agent 时回退给主 Agent 自己干。

## 6. 技术栈：全 TypeScript

- 前后端、运行时、适配器**全部 TS**，不引入 Python。
- `references/omnigent`（Python）**只作思路参考**：其 executor / native bridge / subagent 边界的设计**用 TS 重写**，不做跨语言对接、不真的调用 Python 进程去桥接它。

## 7. Web + 移动端 + 远程访问

- 形态是 Web 应用（现有 Node HTTP + 原生 TS 前端 + SSE），保持无重框架。
- **移动端可用**：布局响应式，手机竖屏下侧栏可收起、composer/事件流/会话切换都能正常操作。
- **远程访问**：部署后通过 frp 暴露，用手机/其它设备访问同一个实例继续开发。
  - 因此状态必须**服务端持久化**（已在 `~/.ad/agentdock/`），不依赖浏览器本地存储——这样多设备访问看到同一份会话。
  - **安全本期不做**，后续加一个账号登录锁一下即可（不阻塞当前开发）。

## 8. UI 要求

- **统一、精致、高级**，沿用现有暗色设计风格（`--bg:#202020` / `--accent:#6f86ff` 那套变量），但要更**精致**——克制、有质感、留白与层次到位；**不要花里胡哨**（不堆动效、不堆渐变、不堆装饰）。
- 桌面与手机**同一套界面自适应**，移动端交互不阉割。
- 关键界面：
  - 会话列表 / 对话主区 / 事件流（已有，打磨）；
  - composer 的统一 Agent/模型下拉（已有，扩成"所有可选项"）；
  - 设置页：环境与 CLI Agent 检测/安装（已有）+ **Provider 配置**（新增：加/改 provider、format、baseUrl、key、models）；
  - 自动编排模式下的**任务拆解 / 子任务分派可视化**（新增：让用户看清主 Agent 把哪段派给了谁、各自进度）。

## 9. 现状可复用资产

| 已有 | 用途 |
|---|---|
| 统一 `AgentEvent` + `AgentDriver` 接口 | 所有后端向上归一，直接沿用 |
| `codex-driver`（OpenAI 侧） | API 后端参考实现 |
| 服务端持久化 `~/.ad/agentdock/state.json` | 多设备/远程访问的状态基础 |
| SSE 事件流 + EventBus | 实时事件推送 |
| 环境检测/安装（server 里 `detectCommand`/`installCommand`） | CLI 后端可用性探测 |
| 暗色设计变量 + 响应式栅格 | UI 打磨基线 |

## 10. 落地顺序（据本文更新）

1. **补 `claude + cli` driver**：底层从"只有 Codex"变成"Codex + Claude 都能当 subagent"。
2. **Provider 配置层 + 两种 format 的 API driver**（openai-responses / anthropic）+ 设置页 Provider UI；主 Agent 脑子模型可配。
3. **手动模式打磨**：下拉框统一列出所有可选项（CLI + 自配 API）。
4. **自动编排最小闭环**：主 Agent 拆解 → LLM 分发 subagent → 收口；串行委派先行。
5. **编排可视化 UI + 移动端自适应 + 上下文交接 + 并行 fan-out + 策略兜底**。
6. **远程访问安全**：后续加账号登录，本期不做。

## 11. 已定 / 后置

- 主 Agent 脑子模型：**默认取下拉框第一个可选项**，不单独指定。
- 远程访问安全：**后置**，后续加账号登录。
- 移动端编排可视化的退化展示：后置到落地第 5 步再定。
