# AgentDock

AgentDock 是一个面向多编码 Agent 的编排项目，目标是让同一个任务可以按需交给 Claude Code、Codex 或后续其它 Agent 运行，并允许 AgentDock 内部的 agent 继续把它们作为 subagent 调用。

当前阶段只建立项目骨架，不绑定具体 SDK 和运行时。

## 当前原型

当前已实现一个全 TypeScript 的最小 Web 原型：

- Node HTTP 后端；
- 原生 TypeScript 前端；
- 本地会话持久化；
- SSE 事件流；
- 简易 Agent runtime；
- Codex SDK adapter。

运行：

```bash
npm install
npm run dev
```

默认地址：

```text
http://127.0.0.1:4173
```

Codex adapter 使用 `@openai/codex-sdk` 的 `Codex.startThread().runStreamed()`。常用环境变量：

- `OPENAI_API_KEY`：OpenAI API Key。
- `OPENAI_BASE_URL`：可选，自定义 OpenAI 兼容网关。
- `AGENTDOCK_WORKSPACE`：Codex 工作目录，默认当前项目目录。
- `AGENTDOCK_CODEX_MODEL`：可选，Codex 模型。
- `AGENTDOCK_CODEX_SANDBOX_MODE`：默认 `workspace-write`。
- `AGENTDOCK_CODEX_APPROVAL_POLICY`：默认 `never`，因为当前 Web 原型还没有实现 Codex approval 回传 UI。
- `AGENTDOCK_CODEX_NETWORK`：设置为 `1` 时允许 Codex 网络访问。
- `PORT`：默认 `4173`。

本地状态不会写入浏览器 localStorage。后端默认保存到：

```text
~/.ad/agentdock/state.json
```

其中包含会话、消息、底层事件和 agent 启用状态。可通过 `AGENTDOCK_HOME` 指定其它保存目录。

## 目录

- `src/agentdock/`：AgentDock 主实现，按运行时、适配器、API、CLI 分层。
- `src/agentdock/adapters/claude/`：Claude Code / Claude Agent SDK 适配器。
- `src/agentdock/adapters/codex/`：Codex SDK / Codex CLI 适配器。
- `src/agentdock/runtime/`：会话、agent、subagent、工具、策略等核心运行时。
- `src/server/`：本地 HTTP 服务和 API。
- `src/web/`：前端页面与样式。
- `docs/`：架构、SDK 调研和设计记录。
- `tests/`：适配器和运行时测试。
- `examples/`：最小使用样例。
- `configs/`：非敏感配置模板。
- `scripts/`：开发和验证脚本。
- `references/`：外部项目参考资料，已被 Git 忽略。

## 引用资料

`references/omnigent/` 仅作为本地参考，不进入版本控制。它当前用于参考：

- Claude Code / Claude Agent SDK 的调用方式；
- Codex native bridge / SDK runtime 的封装方式；
- agent 与 subagent、工具、会话、策略之间的边界设计。
