// 原生 Agent 子系统的规范类型（L0 层）。
//
// 载重不变量 #1：provider 的 wire 形状永远不逃出 L0。
// 上层只能看到这里定义的 canonical Message 与 ResponseEvent 联合。

/** 消息角色。system 单独走 req.system，历史里主要是 user / assistant。 */
export type Role = "system" | "user" | "assistant";

/** JSON Schema 的最小表示（工具参数用）。 */
export type JsonSchema = Record<string, unknown>;

// ---------------------------------------------------------------------------
// ContentPart 联合：一条消息由若干内容块组成
// ---------------------------------------------------------------------------

/** 纯文本块。 */
export type TextPart = { type: "text"; text: string };

/** 模型思考（reasoning）块。 */
export type ThinkingPart = { type: "thinking"; text: string };

/** 模型发起的工具调用块（args 为未知，由工具自行 narrow）。 */
export type ToolCallPart = { type: "tool_call"; id: string; name: string; args: unknown };

/** 工具执行结果块，回填给模型。 */
export type ToolResultPart = {
  type: "tool_result";
  callId: string;
  output: string;
  isError?: boolean;
};

export type ContentPart = TextPart | ThinkingPart | ToolCallPart | ToolResultPart;

/** 规范消息：一个角色 + 一组内容块。 */
export type Message = {
  role: Role;
  content: ContentPart[];
};

// ---------------------------------------------------------------------------
// ResponseEvent 联合：ModelClient.stream 归一化后向上吐的事件
// tool_call 只在完整拼装完成后才发出（不流式吐半截 args）。
// ---------------------------------------------------------------------------

export type ResponseEvent =
  | { kind: "text_delta"; text: string }
  | { kind: "thinking_delta"; text: string }
  | { kind: "tool_call"; call: { id: string; name: string; args: unknown } }
  | { kind: "completed"; usage?: unknown; stopReason?: string }
  | { kind: "error"; message: string };

// ---------------------------------------------------------------------------
// 工具规格 / 模型元数据
// ---------------------------------------------------------------------------

/** 发给模型的工具声明。 */
export type ToolSpec = {
  name: string;
  description: string;
  parameters: JsonSchema;
};

/** 模型能力元数据。wireApi 决定用哪个 L0 客户端。 */
export type ModelMeta = {
  id: string;
  contextLimit: number;
  maxOutput: number;
  supportsTools: boolean;
  wireApi: "anthropic" | "openai-chat" | "openai-responses";
};

// ---------------------------------------------------------------------------
// LoopEvent 联合：L1 loop 向 driver 吐的事件（deltas）
// ---------------------------------------------------------------------------

export type LoopEvent =
  | { kind: "assistant_text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_start"; callId: string; name: string; args: unknown }
  | { kind: "tool_end"; callId: string; name: string; output: string; isError: boolean }
  | { kind: "usage"; usage: unknown }
  | { kind: "error"; message: string }
  | { kind: "done"; finalText: string };
