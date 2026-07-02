// bash 工具：在工作目录下执行一条 shell 命令。
//
// 契约：预期内的失败（非零退出、超时、被中止）不 throw，
// 一律以 { output, isError:true } 结构化返回。
import { spawn } from "node:child_process";
import { createTool, type Tool } from "../tool.js";
import type { ToolContext, ToolResultData } from "../tool.js";

/** 输出上限（字符数），超出后截断。 */
const OUTPUT_CAP = 30_000;
/** 默认超时（毫秒）。 */
const DEFAULT_TIMEOUT = 120_000;

/** 截断过长输出并附加提示。 */
function capOutput(text: string): string {
  if (text.length <= OUTPUT_CAP) return text;
  return text.slice(0, OUTPUT_CAP) + `\n…（输出已截断，超过 ${OUTPUT_CAP} 字符）`;
}

export const bashTool: Tool = createTool({
  name: "bash",
  description: "在工作目录下执行一条 shell 命令并返回其合并输出（stdout + stderr）。",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "要执行的 shell 命令" },
      timeout_ms: { type: "number", description: "超时毫秒数（可选，默认 120000）" },
    },
    required: ["command"],
    additionalProperties: false,
  },
  annotations: { readOnly: false, destructive: true },
  async execute(args: unknown, ctx: ToolContext): Promise<ToolResultData> {
    const a = (args ?? {}) as { command?: unknown; timeout_ms?: unknown };
    const command = a.command;
    if (typeof command !== "string" || command.length === 0) {
      return { output: "command 必须为非空字符串", isError: true };
    }
    const timeout =
      typeof a.timeout_ms === "number" && a.timeout_ms > 0 ? a.timeout_ms : DEFAULT_TIMEOUT;

    if (ctx.signal?.aborted) {
      return { output: "命令在启动前已被中止", isError: true };
    }

    return await new Promise<ToolResultData>((resolve) => {
      const child = spawn("bash", ["-lc", command], { cwd: ctx.cwd });

      let buf = "";
      let settled = false;
      let timedOut = false;

      const append = (chunk: unknown): void => {
        // 已到上限则不再累加，避免内存膨胀
        if (buf.length < OUTPUT_CAP) buf += String(chunk);
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeout);

      const onAbort = (): void => {
        child.kill("SIGKILL");
      };
      ctx.signal?.addEventListener("abort", onAbort, { once: true });

      const cleanup = (): void => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", onAbort);
      };

      const finish = (result: ToolResultData): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };

      child.on("error", (err: Error) => {
        finish({ output: `无法执行命令：${err.message}`, isError: true });
      });

      child.on("close", (code: number | null) => {
        const output = capOutput(buf);
        if (timedOut) {
          finish({ output: `${output}\n命令超时（>${timeout}ms）被终止`, isError: true });
          return;
        }
        if (ctx.signal?.aborted) {
          finish({ output: `${output}\n命令被中止`, isError: true });
          return;
        }
        if (code === 0) {
          finish({ output: output || "（无输出）" });
          return;
        }
        const how = code === null ? "信号终止" : `退出码 ${code}`;
        finish({ output: `${output}\n命令以${how}结束`, isError: true });
      });
    });
  },
});
