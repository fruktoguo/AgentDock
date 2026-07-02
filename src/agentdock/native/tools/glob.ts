// glob 工具：按 glob 模式列举匹配的文件路径（node:fs 递归，无外部依赖）。
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createTool, type Tool } from "../tool.js";
import type { ToolContext, ToolResultData } from "../tool.js";

/** 计算 full 相对 base 的路径（正斜杠），base 之外则返回 full 原样。 */
function relFrom(base: string, full: string): string {
  if (full === base) return "";
  const prefix = base.endsWith("/") ? base : base + "/";
  return full.startsWith(prefix) ? full.slice(prefix.length) : full;
}

/** 递归遍历时跳过的重目录。 */
const SKIP_DIRS = new Set([".git", "node_modules"]);
/** 结果上限，避免超大目录爆量。 */
const MATCH_CAP = 1000;

/**
 * 把 glob 模式编译为锚定整串的 RegExp。
 * 支持：`**`（跨目录，含零段）、`*`（单段内任意）、`?`（单字符）。
 * 路径统一使用正斜杠比较。
 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // ** ：可跨越多个目录层级
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        // 单个 * ：不跨越目录分隔符
        re += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else if ("\\^$.|+()[]{}".includes(c as string)) {
      re += "\\" + c;
      i += 1;
    } else {
      re += c;
      i += 1;
    }
  }
  return new RegExp("^" + re + "$");
}

/** 将相对路径按基准目录解析为绝对路径。 */
function resolveBase(cwd: string, p?: string): string {
  return p ? resolve(cwd, p) : cwd;
}

/** 递归收集 base 下相对路径匹配 re 的文件（正斜杠）。 */
async function walk(
  base: string,
  dir: string,
  re: RegExp,
  out: string[],
  signal?: AbortSignal,
): Promise<void> {
  if (out.length >= MATCH_CAP || signal?.aborted) return;
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // 无权限或已消失的目录，跳过
  }
  for (const entry of entries) {
    if (out.length >= MATCH_CAP || signal?.aborted) return;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(base, full, re, out, signal);
    } else if (entry.isFile()) {
      const rel = relFrom(base, full);
      if (re.test(rel)) out.push(full);
    }
  }
}

export const globTool: Tool = createTool({
  name: "glob",
  description: "按 glob 模式（支持 ** / * / ?）列举匹配的文件路径。",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "glob 模式，如 src/**/*.ts" },
      cwd: { type: "string", description: "搜索根目录（可选，默认工作目录）" },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  annotations: { readOnly: true },
  async execute(args: unknown, ctx: ToolContext): Promise<ToolResultData> {
    const a = (args ?? {}) as { pattern?: unknown; cwd?: unknown };
    if (typeof a.pattern !== "string" || a.pattern.length === 0) {
      return { output: "pattern 必须为非空字符串", isError: true };
    }
    const base = resolveBase(ctx.cwd, typeof a.cwd === "string" ? a.cwd : undefined);
    let re: RegExp;
    try {
      re = globToRegExp(a.pattern);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { output: `无效的 glob 模式：${msg}`, isError: true };
    }

    const out: string[] = [];
    await walk(base, base, re, out, ctx.signal);

    if (ctx.signal?.aborted) return { output: "glob 被中止", isError: true };
    if (out.length === 0) return { output: `无匹配文件：${a.pattern}` };

    out.sort();
    const capped = out.length >= MATCH_CAP ? `\n…（结果上限 ${MATCH_CAP}，可能不完整）` : "";
    return { output: out.join("\n") + capped };
  },
});
