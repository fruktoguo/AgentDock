// edit 工具：对文件做精确字符串替换。
//
// 契约：old_string 不存在，或在非 replace_all 模式下匹配不唯一，均返回结构化错误。
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createTool, type Tool } from "../tool.js";
import type { ToolContext, ToolResultData } from "../tool.js";

/** 将相对路径按 ctx.cwd 解析为绝对路径（p 为绝对路径时 resolve 直接返回 p）。 */
function resolvePath(cwd: string, p: string): string {
  return resolve(cwd, p);
}

/** 统计 needle 在 haystack 中出现的次数（非重叠）。 */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    count += 1;
    from = idx + needle.length;
  }
  return count;
}

export const editTool: Tool = createTool({
  name: "edit",
  description: "在文件中把 old_string 精确替换为 new_string；默认要求唯一匹配。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "目标文件路径（绝对或相对工作目录）" },
      old_string: { type: "string", description: "要被替换的原文（非 replace_all 时需唯一匹配）" },
      new_string: { type: "string", description: "替换后的新文" },
      replace_all: { type: "boolean", description: "是否替换全部匹配（默认 false）" },
    },
    required: ["path", "old_string", "new_string"],
    additionalProperties: false,
  },
  annotations: { readOnly: false, destructive: true },
  async execute(args: unknown, ctx: ToolContext): Promise<ToolResultData> {
    const a = (args ?? {}) as {
      path?: unknown;
      old_string?: unknown;
      new_string?: unknown;
      replace_all?: unknown;
    };
    if (typeof a.path !== "string" || a.path.length === 0) {
      return { output: "path 必须为非空字符串", isError: true };
    }
    if (typeof a.old_string !== "string") {
      return { output: "old_string 必须为字符串", isError: true };
    }
    if (typeof a.new_string !== "string") {
      return { output: "new_string 必须为字符串", isError: true };
    }
    if (a.old_string.length === 0) {
      return { output: "old_string 不能为空", isError: true };
    }
    if (a.old_string === a.new_string) {
      return { output: "old_string 与 new_string 相同，无需替换", isError: true };
    }
    const replaceAll = a.replace_all === true;
    const abs = resolvePath(ctx.cwd, a.path);

    let content: string;
    try {
      content = await readFile(abs, "utf8");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { output: `无法读取文件 ${abs}：${msg}`, isError: true };
    }

    const count = countOccurrences(content, a.old_string);
    if (count === 0) {
      return { output: `未找到 old_string，无法替换：${abs}`, isError: true };
    }
    if (!replaceAll && count > 1) {
      return {
        output: `old_string 在文件中出现 ${count} 次，不唯一；请扩大上下文或设置 replace_all`,
        isError: true,
      };
    }

    const next = replaceAll
      ? content.split(a.old_string).join(a.new_string)
      : content.replace(a.old_string, a.new_string);

    try {
      await writeFile(abs, next, "utf8");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { output: `无法写入文件 ${abs}：${msg}`, isError: true };
    }

    const replaced = replaceAll ? count : 1;
    return { output: `已在 ${abs} 完成替换（${replaced} 处）` };
  },
});
