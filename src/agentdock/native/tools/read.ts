// read 工具：读取文本文件内容，按 cat -n 风格附加行号。
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createTool, type Tool } from "../tool.js";
import type { ToolContext, ToolResultData } from "../tool.js";

/** 默认读取的最大行数。 */
const DEFAULT_LIMIT = 2000;

/** 将相对路径按 ctx.cwd 解析为绝对路径（p 为绝对路径时 resolve 直接返回 p）。 */
function resolvePath(cwd: string, p: string): string {
  return resolve(cwd, p);
}

export const readTool: Tool = createTool({
  name: "read",
  description: "读取指定文本文件的内容，返回带行号（cat -n 风格）的文本，可选起始行与行数。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件的绝对或相对路径（相对则基于工作目录）" },
      offset: { type: "number", description: "起始行号（从 0 开始，可选）" },
      limit: { type: "number", description: "读取的最大行数（可选，默认 2000）" },
    },
    required: ["path"],
    additionalProperties: false,
  },
  annotations: { readOnly: true },
  async execute(args: unknown, ctx: ToolContext): Promise<ToolResultData> {
    const a = (args ?? {}) as { path?: unknown; offset?: unknown; limit?: unknown };
    if (typeof a.path !== "string" || a.path.length === 0) {
      return { output: "path 必须为非空字符串", isError: true };
    }
    const offset = typeof a.offset === "number" && a.offset > 0 ? Math.floor(a.offset) : 0;
    const limit = typeof a.limit === "number" && a.limit > 0 ? Math.floor(a.limit) : DEFAULT_LIMIT;
    const abs = resolvePath(ctx.cwd, a.path);

    let content: string;
    try {
      content = await readFile(abs, "utf8");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { output: `无法读取文件 ${abs}：${msg}`, isError: true };
    }

    // 末尾换行会产生一个空尾行，去掉以避免多出一行
    const lines = content.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

    const slice = lines.slice(offset, offset + limit);
    if (slice.length === 0) {
      return { output: `（文件共 ${lines.length} 行，offset ${offset} 之后无内容）` };
    }

    const numbered = slice
      .map((line, i) => `${String(offset + i + 1).padStart(6)}\t${line}`)
      .join("\n");

    const truncated = offset + limit < lines.length;
    const footer = truncated
      ? `\n…（已显示 ${offset + 1}-${offset + slice.length} 行，共 ${lines.length} 行）`
      : "";
    return { output: numbered + footer };
  },
});
