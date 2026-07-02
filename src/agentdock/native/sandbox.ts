// L5 沙箱原语：路径围栏 + bash 命令分类器（尽力而为、零依赖）。
//
// 设计约束：
//   - 只用 node 内置模块（path/os），不引入任何 npm 依赖，也不联网。
//   - 纯函数：不读全局可变状态，输出只由入参决定（载重不变量 #2）。
//   - 这是一层「尽力而为」的启发式护栏，不是安全边界的最终保证：
//     无 web-tree-sitter（网络封）时用保守的 shell 分词近似解析，宁可收紧（ask）也不放松。
//   - 供 policy.ts 组合：assess() 据此把 write/edit/bash 分级为 auto / ask / reject。

import { homedir } from "node:os";
import { resolve } from "node:path";

/** 决策三态（与 policy.ts 的 Decision 同构；此处独立声明以免 sandbox 反向依赖 policy）。 */
export type SandboxDecision = "auto" | "ask" | "reject";

/** 一次分类的结果：决策 + 人类可读原因（用于审批 UI / 日志 / 结构化错误）。 */
export interface SandboxVerdict {
  decision: SandboxDecision;
  reason: string;
}

/** 路径围栏结果：解析后的绝对路径 + 是否落在工作区根之内。 */
export interface FenceResult {
  /** 解析后的绝对路径（已归一化 .. 穿越、~ 展开由调用方在传入前完成）。 */
  abs: string;
  /** 是否位于 workspace 根之内（含根本身）。 */
  within: boolean;
}

// ---------------------------------------------------------------------------
// 路径围栏
// ---------------------------------------------------------------------------

/**
 * 把 target 相对 workspace 解析为绝对路径，并判定是否落在 workspace 根之内。
 *
 * - target 为相对路径时按 workspace 解析；为绝对路径时 resolve 直接采用该绝对路径
 *   （从而能识别「绝对路径逃逸」）。
 * - `..` 穿越经 resolve 归一化后，若跳出 workspace 根则 within=false。
 * - 判定用「根本身 或 根+分隔符 前缀」避免 `/home/ws` 误判 `/home/ws2` 为内部。
 *
 * 注意：这是词法层围栏，不解析符号链接（best-effort；符号链接逃逸不在本层保证范围内）。
 */
export function fencePath(workspace: string, target: string): FenceResult {
  const root = resolve(workspace);
  const abs = resolve(root, target);
  const within = abs === root || abs.startsWith(root + "/");
  return { abs, within };
}

/** 敏感系统根：写入 / 删除 / 重定向到这些前缀一律视为高危。 */
const SENSITIVE_ROOTS = [
  "/etc",
  "/dev",
  "/sys",
  "/proc",
  "/boot",
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/var",
  "/root",
  "/run",
  "/opt",
  "/srv",
];

/** 判断绝对路径是否指向系统根或敏感目录（"/" 或落在 SENSITIVE_ROOTS 之下）。 */
export function isSensitivePath(abs: string): boolean {
  if (abs === "/") return true;
  return SENSITIVE_ROOTS.some((r) => abs === r || abs.startsWith(r + "/"));
}

/** 把 ~ / $HOME 前缀展开为家目录；其余原样返回（供后续 fencePath 解析）。 */
function expandHome(target: string): string {
  if (target === "~" || target.startsWith("~/")) return homedir() + target.slice(1);
  if (target === "$HOME" || target.startsWith("$HOME/")) return homedir() + target.slice("$HOME".length);
  return target;
}

// ---------------------------------------------------------------------------
// shell 分词（尊重引号 / 转义 / 操作符）
// ---------------------------------------------------------------------------

/** 词法单元：普通词 或 操作符。 */
type Token = { type: "word" | "op"; value: string };

/**
 * 保守的 shell 词法分析：把命令串拆成 word / op 记号。
 * - 单引号内字面（不转义）、双引号内支持 \ 转义；引号内内容永不构成操作符。
 * - 识别的操作符：| || & && ; ;; < << > >> &> >& ( )。
 * - 未转义换行视作语句分隔符（等价于 `;`），使多行脚本每条语句都被独立分段分类。
 * - 词边界处的未引用 `#` 起始为行注释，消费到行尾（不跨换行，保留后续换行的分隔作用）。
 * - 未引用反引号 `` ` `` 视作命令替换边界（等价于 `;` 分段），令内层命令被独立分类，
 *   与 `$()` 经括号分段的处理保持一致（避免把危险内层当作外层安全命令的参数）。
 * - fd 前缀重定向（如 `2>`）里的数字会作为 word 落在命令段（无害噪声），`>` 仍识别为重定向。
 */
function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let word = "";
  let hasWord = false;
  const flush = (): void => {
    if (hasWord) {
      tokens.push({ type: "word", value: word });
      word = "";
      hasWord = false;
    }
  };

  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;

    // 单引号：内部字面，无转义。
    if (ch === "'") {
      hasWord = true;
      i += 1;
      while (i < input.length && input[i] !== "'") {
        word += input[i];
        i += 1;
      }
      i += 1; // 跳过闭合引号（未闭合则自然结束）
      continue;
    }
    // 双引号：内部支持 \ 转义。
    if (ch === '"') {
      hasWord = true;
      i += 1;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === "\\" && i + 1 < input.length) {
          word += input[i + 1];
          i += 2;
        } else {
          word += input[i];
          i += 1;
        }
      }
      i += 1;
      continue;
    }
    // 裸转义：下一个字符字面。
    if (ch === "\\") {
      if (i + 1 < input.length) {
        word += input[i + 1];
        hasWord = true;
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    // 反引号命令替换：作为分段边界（等价于 `;`），使内层命令被独立分类。
    // 转义反引号 `\`` 已在上面的裸转义分支被当作字面消费，不会到达这里；
    // 双/单引号内的反引号也已被相应引号分支吞下，故此处仅处理未引用的反引号。
    // 成对反引号各产生一个 `;`：开引号前切段、闭引号后切段，内层落为独立命令段。
    if (ch === "`") {
      flush();
      tokens.push({ type: "op", value: ";" });
      i += 1;
      continue;
    }
    // 行注释：词边界处（非词内）的未引用 `#` 起始，注释到行尾为止。
    // 仅在 hasWord=false（词边界）时生效，与 bash 一致——`foo#bar` 中的 `#` 为字面。
    // 不跨换行（遇 `\n` 停止），以便随后的换行仍作为语句分隔符。
    if (ch === "#" && !hasWord) {
      while (i < input.length && input[i] !== "\n") i += 1;
      continue;
    }
    // 换行：作为语句分隔符（等价于 `;`），令多行脚本中每条语句的首命令都被独立分类。
    // 必须先于下面的通用空白分支（`\n` 亦匹配 `\s`），否则会被当作普通空白吞并。
    if (ch === "\n") {
      flush();
      tokens.push({ type: "op", value: ";" });
      i += 1;
      continue;
    }
    // 空白：分词。
    if (/\s/.test(ch)) {
      flush();
      i += 1;
      continue;
    }
    // 操作符。
    if ("|&;<>()".includes(ch)) {
      flush();
      let op = ch;
      const next = input[i + 1];
      if (
        (ch === "|" && next === "|") ||
        (ch === "&" && next === "&") ||
        (ch === ";" && next === ";") ||
        (ch === ">" && next === ">") ||
        (ch === "<" && next === "<")
      ) {
        op = ch + next;
        i += 2;
      } else {
        i += 1;
      }
      // &> 合并重定向。
      if (op === "&" && input[i] === ">") {
        op = "&>";
        i += 1;
      }
      tokens.push({ type: "op", value: op });
      continue;
    }
    // 普通字符。
    word += ch;
    hasWord = true;
    i += 1;
  }
  flush();
  return tokens;
}

/** 分段结果：一个简单命令（词序列）+ 其重定向目标。 */
interface Segment {
  words: string[];
  redirects: string[];
}

/** 段分隔操作符：管道 / 逻辑连接 / 顺序 / 后台 / 子 shell 分组。 */
const SEP_OPS = new Set(["|", "||", "&", "&&", ";", ";;", "(", ")"]);
/** 重定向操作符：其后紧跟的 word 为重定向目标。 */
const REDIR_OPS = new Set([">", ">>", "<", "<<", "&>", ">&"]);

/** 把记号流按分隔符切成若干简单命令段，并抽出各段的重定向目标。 */
function splitSegments(tokens: Token[]): Segment[] {
  const segs: Segment[] = [];
  let words: string[] = [];
  let redirects: string[] = [];
  let expectRedirTarget = false;

  const push = (): void => {
    if (words.length > 0 || redirects.length > 0) {
      segs.push({ words, redirects });
    }
    words = [];
    redirects = [];
  };

  for (const t of tokens) {
    if (t.type === "op") {
      if (SEP_OPS.has(t.value)) {
        push();
        expectRedirTarget = false;
      } else if (REDIR_OPS.has(t.value)) {
        expectRedirTarget = true;
      }
      // 其余 op（不存在于两集合）忽略。
      continue;
    }
    if (expectRedirTarget) {
      redirects.push(t.value);
      expectRedirTarget = false;
    } else {
      words.push(t.value);
    }
  }
  push();
  return segs;
}

/** 去掉命令段前缀的 `VAR=值` 环境赋值，以及一个 `env` 包装器及其后续赋值，返回真实命令词序列。 */
function stripLeading(words: string[]): string[] {
  const isAssign = (w: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w);
  let i = 0;
  while (i < words.length && isAssign(words[i]!)) i += 1;
  if (words[i] === "env") {
    i += 1;
    while (i < words.length && isAssign(words[i]!)) i += 1;
  }
  return words.slice(i);
}

/** 取命令的基名：/usr/bin/ls -> ls（用于白名单/黑名单匹配）。 */
function baseCommand(cmd: string): string {
  const idx = cmd.lastIndexOf("/");
  return idx === -1 ? cmd : cmd.slice(idx + 1);
}

// ---------------------------------------------------------------------------
// 命令分类词表
// ---------------------------------------------------------------------------

/** 提权：一律 reject（本层不允许自动提权，即便审批也应显式改配置）。 */
const PRIV_ESCALATION = new Set(["sudo", "su", "doas", "pkexec"]);
/** 关机 / 重启 / 运行级：reject。 */
const SHUTDOWN = new Set(["shutdown", "reboot", "halt", "poweroff", "init", "telinit"]);
/** 子 shell / 解释器 / eval：可执行任意代码，无法静态判定 -> ask（下游若是下载管道则更早 reject）。 */
const SHELL_INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh", "source", ".", "eval", "exec"]);
/** 只读安全命令白名单：无副作用，可 auto。 */
const SAFE_READONLY = new Set([
  // 文本查看 / 处理
  "ls", "cat", "echo", "pwd", "printf", "head", "tail", "wc", "sort", "uniq", "cut", "tr", "nl", "tac", "column", "fold",
  // 搜索
  "grep", "egrep", "fgrep", "rg", "ag", "find", "locate", "which", "type", "whereis",
  // 比较 / 结构化
  "diff", "cmp", "comm", "awk", "jq", "yq", "xxd", "od", "strings", "base64",
  "md5sum", "sha1sum", "sha256sum", "cksum",
  // 系统只读信息
  "date", "cal", "uptime", "whoami", "id", "groups", "uname", "hostname", "arch", "printenv", "locale",
  "du", "df", "stat", "file", "basename", "dirname", "realpath", "readlink", "tree",
  // 只读探测 / 常量
  "true", "false", "test", "seq", "tty", "lscpu", "free", "ps", "ss", "netstat", "lsof", "w", "env",
]);

// ---------------------------------------------------------------------------
// 单命令 / 重定向 / rm 的细粒度分类
// ---------------------------------------------------------------------------

/** 判定 rm 目标是否为「整盘/家目录/通配」等灾难级目标（无论是否 -r）。 */
const WIPE_TOKENS = new Set(["/", "/*", "~", "~/", "*", "*/", ".", "./", "..", "../", "$HOME", "$HOME/", "$HOME/*"]);

/** 分类一次重定向目标：工作区内放行；敏感/根 -> reject；工作区外 -> ask。 */
function classifyRedirect(target: string, workspace: string): SandboxVerdict | null {
  // 丢弃到 /dev/null 是常见无害用法，特例放行。
  if (target === "/dev/null") return null;
  const { abs, within } = fencePath(workspace, expandHome(target));
  if (within) return null; // 工作区内写 -> 不降级
  if (isSensitivePath(abs)) return { decision: "reject", reason: `重定向到敏感路径：${target}` };
  return { decision: "ask", reason: `重定向到工作区外：${target}` };
}

/** 分类 rm：整盘/敏感/工作区外递归删除 -> reject；其余删除 -> ask。 */
function classifyRm(args: string[], workspace: string): SandboxVerdict {
  const recursive = args.some((a) => a === "--recursive" || (/^-[A-Za-z]*$/.test(a) && /r/i.test(a)));
  const targets = args.filter((a) => !a.startsWith("-"));
  for (const t of targets) {
    if (WIPE_TOKENS.has(t)) return { decision: "reject", reason: `rm 目标危险：${t}` };
    const { abs, within } = fencePath(workspace, expandHome(t));
    if (isSensitivePath(abs)) return { decision: "reject", reason: `rm 敏感路径：${t}` };
    if (!within && recursive) return { decision: "reject", reason: `rm -r 工作区外：${t}` };
  }
  return { decision: "ask", reason: "rm 删除文件" };
}

/** git 只读子命令：不改工作区/仓库状态，可 auto。 */
const GIT_READONLY = new Set([
  "status", "diff", "log", "show", "rev-parse", "ls-files", "ls-tree", "cat-file", "rev-list",
  "describe", "blame", "shortlog", "reflog", "name-rev", "for-each-ref", "whatchanged", "grep", "annotate",
]);

/** 分类 git：只读子命令 auto；其余（可能改仓库，如 branch -D / commit / push / checkout）-> ask。 */
function classifyGit(args: string[]): SandboxVerdict {
  const sub = args.find((a) => !a.startsWith("-"));
  if (sub && GIT_READONLY.has(sub)) return { decision: "auto", reason: `git ${sub}（只读）` };
  return { decision: "ask", reason: `git ${sub ?? "(无子命令)"} 可能改动仓库` };
}

/** 分类单个简单命令（已去 env 前缀）。 */
function classifyCommand(cmd: string, args: string[], workspace: string): SandboxVerdict {
  const base = baseCommand(cmd);

  if (PRIV_ESCALATION.has(base)) return { decision: "reject", reason: `提权命令：${base}` };
  if (SHUTDOWN.has(base)) return { decision: "reject", reason: `关机/重启命令：${base}` };
  if (base.startsWith("mkfs")) return { decision: "reject", reason: `格式化命令：${base}` };

  if (base === "dd") {
    if (args.some((a) => /^of=\/dev\//.test(a))) return { decision: "reject", reason: "dd 写入块设备" };
    return { decision: "ask", reason: "dd 命令" };
  }
  if (base === "rm") return classifyRm(args, workspace);
  if (base === "chmod" || base === "chown") {
    const recursive = args.some((a) => a === "--recursive" || /^-[A-Za-z]*R/.test(a));
    if (recursive) {
      const hit = args.find((a) => !a.startsWith("-") && (isSensitivePath(fencePath(workspace, expandHome(a)).abs) || expandHome(a) === "/"));
      if (hit) return { decision: "reject", reason: `${base} -R 敏感路径：${hit}` };
    }
    return { decision: "ask", reason: `${base} 修改权限/属主` };
  }
  if (base === "find") {
    // find 默认只读遍历；带删除/执行动作时可任意副作用 -> ask。
    if (args.some((a) => a === "-delete" || a === "-exec" || a === "-execdir" || a === "-ok" || a === "-okdir")) {
      return { decision: "ask", reason: "find 带删除/执行动作" };
    }
    return { decision: "auto", reason: "find 只读遍历" };
  }
  if (base === "git") return classifyGit(args);
  if (SHELL_INTERPRETERS.has(base)) return { decision: "ask", reason: `调用子 shell/解释器：${base}` };
  if (SAFE_READONLY.has(base)) return { decision: "auto", reason: `只读命令：${base}` };

  // 默认收紧：未知或可能有副作用的命令 -> ask。
  return { decision: "ask", reason: `未识别命令：${base}` };
}

// ---------------------------------------------------------------------------
// 顶层：分类整条 bash 命令
// ---------------------------------------------------------------------------

/** 决策优先级：reject > ask > auto（取最严）。 */
function tighten(current: SandboxDecision, next: SandboxDecision): SandboxDecision {
  if (current === "reject" || next === "reject") return "reject";
  if (current === "ask" || next === "ask") return "ask";
  return "auto";
}

/**
 * 分类一条 bash 命令，返回 auto / ask / reject + 原因。
 *
 * 顺序：
 *   1. 跨段灾难模式（fork bomb、下载后管道执行）先判 reject；
 *   2. 分段扫描：逐段做重定向围栏 + 首命令分类，按「最严」合并；
 *   3. 全部只读安全且无越界重定向 -> auto；出现可疑项按 ask/reject 收紧。
 *
 * 无法解析 / 空命令 / 未识别命令一律收紧为 ask（默认收紧原则）。
 */
export function classifyBash(command: string, workspace: string): SandboxVerdict {
  const raw = command.trim();
  if (raw.length === 0) return { decision: "ask", reason: "空命令" };

  // —— 跨段灾难模式（分段前先判） ——
  const collapsed = raw.replace(/\s+/g, "");
  // fork bomb: :(){ :|:& };:
  if (collapsed.includes(":(){") && (collapsed.includes(":|:") || collapsed.includes("|:&"))) {
    return { decision: "reject", reason: "疑似 fork bomb" };
  }
  // 下载后直接管道执行：curl/wget/fetch ... | sh/bash/python/perl/ruby/node
  if (
    /\b(curl|wget|fetch)\b[\s\S]*?\|\s*(sudo\s+)?(sh|bash|zsh|dash|ksh|python[0-9.]*|perl|ruby|node)\b/i.test(raw)
  ) {
    return { decision: "reject", reason: "下载内容后直接管道执行" };
  }

  const segments = splitSegments(lex(raw));
  if (segments.length === 0) return { decision: "ask", reason: "无法解析命令" };

  let decision: SandboxDecision = "auto";
  const reasons: string[] = [];
  const merge = (v: SandboxVerdict): void => {
    decision = tighten(decision, v.decision);
    if (v.decision !== "auto") reasons.push(v.reason);
  };

  for (const seg of segments) {
    for (const target of seg.redirects) {
      const v = classifyRedirect(target, workspace);
      if (v) merge(v);
    }
    const words = stripLeading(seg.words);
    const cmd = words[0];
    if (cmd === undefined) {
      // 只有重定向没有命令（如 `> file`）：无命令可判，保守 ask。
      if (seg.redirects.length === 0) merge({ decision: "ask", reason: "空命令段" });
      continue;
    }
    merge(classifyCommand(cmd, words.slice(1), workspace));
  }

  const reason = reasons.length > 0 ? reasons.join("；") : "全部为只读安全命令";
  return { decision, reason };
}
