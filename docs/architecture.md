# AgentDock 架构草案

## 目标

AgentDock 的核心目标是把不同编码 Agent 抽象成统一的可调度能力：

- 顶层任务可以选择 Claude Code、Codex 或其它 agent 执行；
- AgentDock 自身 agent 可以继续把 Claude Code、Codex 作为 subagent 使用；
- 上层只依赖统一的任务、会话、工具和事件模型，不直接耦合某个 SDK。

## 初始分层

- `runtime/agents`：定义 AgentDock 内部 agent 的生命周期和执行入口。
- `runtime/subagents`：定义 subagent 调度、父子任务关系、结果回传和取消。
- `runtime/sessions`：保存单次任务和多轮会话状态。
- `runtime/tools`：提供工具注册、调用、权限和结果归一化。
- `runtime/policies`：处理模型选择、权限、成本、沙箱等策略。
- `adapters/claude`：封装 Claude Code / Claude Agent SDK。
- `adapters/codex`：封装 Codex SDK / Codex CLI。
- `api`：对外暴露 HTTP / RPC 能力。
- `cli`：本地命令行入口。
- `config`：配置加载、环境变量解析和 provider 设置。

## 本地状态

Web 原型的会话不保存到浏览器。后端负责读写 `~/.ad/agentdock/state.json`，当前保存：

- 会话列表、消息和事件；
- 每个 agent 的启用状态。

设置页分为两个层次：

- 环境：Node.js、npm、项目依赖等基础包体；
- Agent：Codex、Claude Code、OpenCode、Hermes 等 agent 的安装、启用和模型来源。

输入框只展示已安装、已启用且当前后端 adapter 可运行的 agent。

## 适配器边界

后续实现时建议先定义一个窄接口，例如：

```text
AgentDriver
- startSession(request)
- runTurn(sessionId, input)
- streamEvents(sessionId)
- cancel(sessionId)
- close(sessionId)
```

Claude、Codex 和其它 provider 都实现这个边界。runtime 只处理统一事件，不关心底层 SDK 是 Python、TypeScript，还是 CLI bridge。

## subagent 模型

subagent 不应该是特殊分支逻辑，而应该是同一套 `AgentDriver` 的嵌套调用：

- 父 agent 发起 `SubagentTask`；
- runtime 根据策略选择 Claude/Codex adapter；
- subagent 事件流被归并为父任务可消费的结构化结果；
- 权限、工作目录、环境变量、预算和取消信号由 runtime 统一下发。

这样可以避免把 Claude 或 Codex 的私有概念泄露到上层业务里。
