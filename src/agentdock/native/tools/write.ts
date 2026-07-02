// write 工具：写入（覆盖）文件，必要时创建父目录。
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createTool, type Tool } from "../tool.js";
import type { ToolContext, ToolResultData } from "../tool.js";

/** 将相对路径按 ctx.cwd 解析为绝对路径（p 为绝对路径时 resolve 直接返回 p）。 */
function resolvePath(cwd: string, p: string): string {
  return resolve(cwd, p);
}

export const writeTool: Tool = createTool({
  name: "write",
  description: "将内容写入指定文件，若父目录不存在则创建，文件已存在则覆盖。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "目标文件路径（绝对或相对工作目录）" },
      content: { type: "string", description: "要写入的完整内容" },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  annotations: { readOnly: false, destructive: true },
  async execute(args: unknown, ctx: ToolContext): Promise<ToolResultData> {
    const a = (args ?? {}) as { path?: unknown; content?: unknown };
    if (typeof a.path !== "string" || a.path.length === 0) {
      return { output: "path 必须为非空字符串", isError: true };
    }
    if (typeof a.content !== "string") {
      return { output: "content 必须为字符串", isError: true };
    }
    const abs = resolvePath(ctx.cwd, a.path);
    try {
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, a.content, "utf8");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { output: `无法写入文件 ${abs}：${msg}`, isError: true };
    }
    const bytes = new TextEncoder().encode(a.content).length;
    return { output: `已写入 ${abs}（${bytes} 字节）` };
  },
});
