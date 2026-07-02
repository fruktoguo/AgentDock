# SDK 调研记录

## 结论

Claude Code / Claude Agent SDK 和 Codex SDK 都不是只有 Python。当前可以按项目形态选择 Python 或 TypeScript：

- Claude Agent SDK：官方文档提供 TypeScript 和 Python SDK。
- Codex SDK：官方文档提供 TypeScript 和 Python SDK。
- `omnigent` 当前主要是 Python 实现，适合参考 executor、会话、工具桥接、native bridge 和 subagent 边界。

## 对 AgentDock 的影响

如果优先复用 `omnigent` 的实现思路，Python 迁移成本更低；如果优先做 Web/API/前端一体化，TypeScript 也可行。建议 AgentDock 先把 provider 适配器接口定稳，再决定首个实现语言。

## 本地参考入口

- `references/omnigent/inner/claude_sdk_executor.py`
- `references/omnigent/inner/codex_native_executor.py`
- `references/omnigent/inner/openai_agents_sdk_executor.py`

## 官方资料

- Claude Agent SDK 文档：<https://docs.anthropic.com/en/docs/claude-code/sdk/sdk-overview>
- Codex SDK 文档：<https://developers.openai.com/codex/sdk>

