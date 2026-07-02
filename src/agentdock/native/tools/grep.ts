// grep 工具：按正则在文件内容中搜索。
//
// 优先调用 ripgrep（rg）；若系统缺少 rg 则回退到纯 JS 递归搜索。
import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createTool, type Tool } from "../tool.js";
import type { ToolContext, ToolResultData } from "../tool.js";
import { globToRegExp } from "./glob.js";

/** 取路径最后一段（文件名）。 */
function baseName(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx === -1 ? p : p.slice(idx + 1);
}

/** 计算 full 相对 base 的路径（正斜杠），base 之外则返回 full 原样。 */
function relFrom(base: string, full: string): string {
  if (full === base) return "";
  const prefix = base.endsWith("/") ? base : base + "/";
  return full.startsWith(prefix) ? full.slice(prefix.length) : full;
}

/** 输出上限（字符数）。 */
const OUTPUT_CAP = 30_000;
/** JS 回退命中上限。 */
const MATCH_CAP = 5000;
/** JS 回退遍历时跳过的重目录。 */
const SKIP_DIRS = new Set([".git", "node_modules"]);
/** 二进制探测：含 NUL 字节即视为二进制。 */
const NUL_RE = /\u0000/;

/** 将相对路径按 ctx.cwd 解析为绝对路径。 */
function resolvePath(cwd: string, p?: string): string {
  return p ? resolve(cwd, p) : cwd;
}

/** 截断过长输出。 */
function capOutput(text: string): string {
  if (text.length <= OUTPUT_CAP) return text;
  return text.slice(0, OUTPUT_CAP) + `\n…（输出已截断，超过 ${OUTPUT_CAP} 字符）`;
}

/** 通过 rg 搜索；rg 缺失时返回 "no-rg" 供上层回退。 */
function runRipgrep(
  pattern: string,
  searchPath: string,
  glob: string | undefined,
  signal: AbortSignal | undefined,
): Promise<{ output: string; isError: boolean } | "no-rg"> {
  return new Promise((resolveResult, reject) => {
    const rgArgs = ["--line-number", "--no-heading", "--color", "never"];
    if (glob) rgArgs.push("-g", glob);
    rgArgs.push("--", pattern, searchPath);

    const child = spawn("rg", rgArgs);
    let out = "";
    let err = "";
    const append = (chunk: unknown): void => {
      if (out.length < OUTPUT_CAP) out += String(chunk);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", (c: unknown) => {
      err += String(c);
    });

    const onAbort = (): void => {
      child.kill("SIGKILL");
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = (): void => signal?.removeEventListener("abort", onAbort);

    child.on("error", (e: Error) => {
      cleanup();
      // rg 不存在时 spawn 抛 ENOENT，回退到 JS 搜索
      if ((e as { code?: string }).code === "ENOENT") resolveResult("no-rg");
      else reject(e);
    });
    child.on("close", (code: number | null) => {
      cleanup();
      if (signal?.aborted) {
        resolveResult({ output: "grep 被中止", isError: true });
        return;
      }
      // rg：0=有匹配，1=无匹配，>=2=错误
      if (code === 0) resolveResult({ output: capOutput(out) || "（无输出）", isError: false });
      else if (code === 1) resolveResult({ output: `无匹配：${pattern}`, isError: false });
      else resolveResult({ output: `rg 出错：${err.trim() || `退出码 ${code}`}`, isError: true });
    });
  });
}

/** 纯 JS 递归搜索回退。globMatch 为 undefined 表示不按文件名过滤。 */
async function runJsGrep(
  re: RegExp,
  searchPath: string,
  globMatch: ((rel: string, name: string) => boolean) | undefined,
  signal: AbortSignal | undefined,
): Promise<{ output: string; isError: boolean }> {
  const results: string[] = [];

  const searchFile = async (file: string, rel: string): Promise<void> => {
    if (globMatch && !globMatch(rel, baseName(file))) return;
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch {
      return;
    }
    if (NUL_RE.test(content)) return; // 跳过二进制
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (results.length >= MATCH_CAP) return;
      if (re.test(lines[i] as string)) {
        results.push(`${file}:${i + 1}:${lines[i]}`);
      }
    }
  };

  const walk = async (dir: string, base: string): Promise<void> => {
    if (signal?.aborted || results.length >= MATCH_CAP) return;
    let entries: Awaited<ReturnType<typeof readdir>>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (signal?.aborted || results.length >= MATCH_CAP) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(full, base);
      } else if (entry.isFile()) {
        const rel = relFrom(base, full);
        await searchFile(full, rel);
      }
    }
  };

  // searchPath 可能是文件或目录
  let isDir = false;
  try {
    isDir = (await stat(searchPath)).isDirectory();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { output: `无法访问搜索路径 ${searchPath}：${msg}`, isError: true };
  }
  if (isDir) await walk(searchPath, searchPath);
  else await searchFile(searchPath, baseName(searchPath));

  if (signal?.aborted) return { output: "grep 被中止", isError: true };
  if (results.length === 0) return { output: `无匹配：${re.source}`, isError: false };
  return { output: capOutput(results.join("\n")), isError: false };
}

export const grepTool: Tool = createTool({
  name: "grep",
  description: "在工作目录（或指定路径）下按正则搜索文件内容，返回 文件:行号:内容。",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "正则表达式" },
      path: { type: "string", description: "搜索的根目录或文件（可选，默认工作目录）" },
      glob: { type: "string", description: "限定文件名的 glob，如 *.ts（可选）" },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  annotations: { readOnly: true },
  async execute(args: unknown, ctx: ToolContext): Promise<ToolResultData> {
    const a = (args ?? {}) as { pattern?: unknown; path?: unknown; glob?: unknown };
    if (typeof a.pattern !== "string" || a.pattern.length === 0) {
      return { output: "pattern 必须为非空字符串", isError: true };
    }
    const glob = typeof a.glob === "string" && a.glob.length > 0 ? a.glob : undefined;
    const searchPath = resolvePath(ctx.cwd, typeof a.path === "string" ? a.path : undefined);

    if (ctx.signal?.aborted) return { output: "grep 在启动前已被中止", isError: true };

    // 先尝试 rg
    try {
      const rgResult = await runRipgrep(a.pattern, searchPath, glob, ctx.signal);
      if (rgResult !== "no-rg") return rgResult;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { output: `rg 执行失败：${msg}`, isError: true };
    }

    // 回退：JS 递归搜索
    let re: RegExp;
    try {
      re = new RegExp(a.pattern);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { output: `无效的正则表达式：${msg}`, isError: true };
    }
    // 无 "/" 的 glob 按 basename 匹配（与 ripgrep 语义一致）；含 "/" 则按相对路径匹配
    let globMatch: ((rel: string, name: string) => boolean) | undefined;
    if (glob) {
      const globRe = globToRegExp(glob);
      globMatch = glob.includes("/")
        ? (rel: string): boolean => globRe.test(rel)
        : (_rel: string, name: string): boolean => globRe.test(name);
    }
    return await runJsGrep(re, searchPath, globMatch, ctx.signal);
  },
});
