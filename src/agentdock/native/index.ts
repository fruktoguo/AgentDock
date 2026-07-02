// 原生 Agent 子系统的公开面（barrel）。

export type {
  Role,
  JsonSchema,
  TextPart,
  ThinkingPart,
  ToolCallPart,
  ToolResultPart,
  ContentPart,
  Message,
  ResponseEvent,
  ToolSpec,
  ModelMeta,
  LoopEvent,
} from "./types.js";

export type { ModelClient, ModelStreamRequest, ModelClientDeps } from "./model.js";
export { AnthropicModelClient } from "./model.js";

export type { Tool, ToolContext, ToolResultData, DispatchFn, DispatchOptions } from "./tool.js";
export { createTool, ToolRegistry } from "./tool.js";

export type { Decision, PolicyInput, PolicyConfig, PolicyMode } from "./policy.js";
export { assess, makeAsk, defaultPolicyConfig } from "./policy.js";

export type { SandboxDecision, SandboxVerdict, FenceResult } from "./sandbox.js";
export { fencePath, classifyBash, isSensitivePath } from "./sandbox.js";

export type { RunAgentLoopOptions } from "./loop.js";
export { runAgentLoop } from "./loop.js";

export type { CompactOptions } from "./compaction.js";
export { compact, estimateTokens, truncateToolOutputs, summarizePrefix } from "./compaction.js";

export { registerBuiltins } from "./tools/index.js";

export type { SkillMeta, SkillDetail } from "./skills.js";
export { SkillRegistry, parseFrontmatter } from "./skills.js";
export { createSkillTool } from "./tools/skill.js";
export { createTaskTool, MAX_DISPATCH_DEPTH } from "./tools/task.js";

export type { McpServerSpec, McpClientOptions, McpToolDef, McpCallResult } from "./mcp/client.js";
export { McpClient } from "./mcp/client.js";
export type { McpManagerOptions, McpServerStatus } from "./mcp/manager.js";
export { McpManager, mcpToolName, resolveMcpSpecs } from "./mcp/manager.js";

export { NativeAgentDriver, buildSystemPrompt } from "./driver.js";
