import type { AgentDriver, AgentEvent, RunTurnInput } from "../../runtime/types.js";
import { errorMessage, makeEvent, safeJsonParse } from "../shared.js";
import { spawnStreaming } from "../process-stream.js";

type ClaudeStreamEvent = {
  type?: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  result?: string;
  is_error?: boolean;
  usage?: unknown;
  total_cost_usd?: number;
  message?: {
    content?: Array<{
      type?: string;
      text?: string;
      thinking?: string;
      name?: string;
      input?: unknown;
      content?: unknown;
      tool_use_id?: string;
      is_error?: boolean;
    }>;
  };
};

/**
 * 驱动本机已安装/已登录的 Claude Code CLI（print + stream-json）。
 * 复用其订阅额度与整套工具/文件/权限能力，作为 subagent。
 */
export class ClaudeCliDriver implements AgentDriver {
  async *runTurn(input: RunTurnInput): AsyncGenerator<AgentEvent> {
    const label = input.sourceLabel ?? "Claude Code";
    const args = ["-p", "--output-format", "stream-json", "--verbose"];
    if (input.model) {
      args.push("--model", input.model);
    }
    if (input.session.claudeSessionId) {
      args.push("--resume", input.session.claudeSessionId);
    }
    if (process.env.AGENTDOCK_CLAUDE_SKIP_PERMISSIONS !== "0") {
      args.push("--dangerously-skip-permissions");
    }
    const permissionMode = process.env.AGENTDOCK_CLAUDE_PERMISSION_MODE;
    if (permissionMode) {
      args.push("--permission-mode", permissionMode);
    }

    yield makeEvent(input, "lifecycle", `${label} 开始`, "正在调用 Claude Code CLI。", "started");

    const workspace = process.env.AGENTDOCK_WORKSPACE || process.cwd();
    const handle = spawnStreaming("claude", args, {
      cwd: workspace,
      input: input.content,
      signal: input.signal,
    });

    let finalText = "";
    let sawResult = false;
    try {
      for await (const line of handle.lines) {
        const event = safeJsonParse<ClaudeStreamEvent>(line);
        if (!event) {
          continue;
        }
        yield* this.mapEvent(input, label, event);
        if (event.type === "result") {
          sawResult = true;
          if (typeof event.result === "string") {
            finalText = event.result;
          }
        }
      }
    } catch (error) {
      yield makeEvent(input, "error", `${label} 执行失败`, errorMessage(error), "failed");
      return;
    }

    const result = await handle.done;
    if (!sawResult && result.code !== 0) {
      yield makeEvent(
        input,
        "error",
        `${label} 退出异常`,
        `退出码 ${result.code ?? "null"}\n${result.stderr.slice(-2000) || "（无 stderr）"}\n\n提示：请确认已 \`claude\` 登录，且本机已安装 Claude Code。`,
        "failed",
      );
    }
  }

  private *mapEvent(input: RunTurnInput, label: string, event: ClaudeStreamEvent): Generator<AgentEvent> {
    if (event.type === "system" && event.subtype === "init") {
      if (event.session_id) {
        // agent-service 会据 rawType 存 claudeSessionId 以便续接
        yield makeEvent(input, "lifecycle", `${label} 会话`, event.session_id, "completed", "claude.session");
      }
      return;
    }
    if (event.type === "assistant" && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === "thinking" && block.thinking?.trim()) {
          yield makeEvent(input, "reasoning", "思考", block.thinking, "updated");
        } else if (block.type === "tool_use") {
          yield makeEvent(
            input,
            "tool",
            `工具 ${block.name ?? ""}`,
            JSON.stringify(block.input ?? {}, null, 2),
            "started",
          );
        }
        // 中间 text 块跳过，最终回复以 result 为准，避免重复气泡
      }
      return;
    }
    if (event.type === "user" && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === "tool_result") {
          const body = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "", null, 2);
          yield makeEvent(input, "tool", "工具结果", body, block.is_error ? "failed" : "completed");
        }
      }
      return;
    }
    if (event.type === "result") {
      if (event.is_error) {
        yield makeEvent(input, "error", `${label} 失败`, event.result ?? "未知错误", "failed");
        return;
      }
      if (typeof event.result === "string" && event.result.trim()) {
        yield makeEvent(input, "message", label, event.result, "completed");
      }
      if (event.usage) {
        const usage = { ...(event.usage as Record<string, unknown>), total_cost_usd: event.total_cost_usd };
        yield makeEvent(input, "usage", "Token usage", JSON.stringify(usage, null, 2), "completed");
      }
    }
  }
}
