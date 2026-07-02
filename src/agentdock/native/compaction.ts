// L4 工作上下文压缩：让长会话不撞上下文上限崩掉。
//
// 设计要点（务必遵守）：
//   - 非破坏：绝不删改 canonical 历史 messages。这里所有函数都返回「压缩视图」新数组，
//     原始 messages 由调用方（loop）照旧原地追加，互不影响。
//   - 两级压缩：
//       (1) truncateToolOutputs：裁剪超大 tool_result 输出（保留头+尾，中间标记省略）。
//       (2) summarizePrefix / compact：估算 token 超预算时，把最旧一段前缀折叠成一条摘要消息。
//   - Orphan 安全（最关键）：压缩视图里绝不能出现「有 tool_call 无配对 tool_result」或反之，
//     否则真实 Anthropic 会 400。折叠只在「干净边界」切分——整对保留或整对丢弃。
//   - token 估算：无 tokenizer 依赖（网络封）。启发式约 4 字符/token。
//   - 摘要：第一版为「确定性结构摘要」（拼接被丢弃消息的截断文本，标注角色/工具名），不调 LLM，
//     离线可测；但留 summarize 注入钩子，未来可换 LLM 摘要。correct over clever。

import type { ContentPart, Message, Role } from "./types.js";

// ---------------------------------------------------------------------------
// 常量（预算与阈值）
// ---------------------------------------------------------------------------

/** 启发式：约 4 字符 ≈ 1 token（无网络 tokenizer 时的兜底）。 */
const CHARS_PER_TOKEN = 4;

/** 每条消息 / 每个 content part 的结构开销（角色标签、分隔符等）粗估字符数。 */
const MESSAGE_OVERHEAD_CHARS = 8;
const PART_OVERHEAD_CHARS = 8;

/** 单条 tool_result 输出的字符上限；超出则裁成头+尾。 */
const DEFAULT_MAX_TOOL_CHARS = 8000;

/** 至少逐字保留的最近消息条数（绝不折叠进摘要）。 */
const DEFAULT_KEEP_RECENT = 6;

/** 缺失 ModelMeta.contextLimit 时的兜底模型上下文（token）。 */
const DEFAULT_CONTEXT_LIMIT = 200_000;

/** 为模型输出预留的 token（从上下文预算中扣除）。 */
const OUTPUT_RESERVE_TOKENS = 16_000;

/** 输入视图预算的下限，避免预留扣成负数/过小。 */
const MIN_BUDGET_TOKENS = 1024;

/** 摘要中每条截断片段的字符上限。 */
const SUMMARY_SNIPPET_CHARS = 160;

/** 整条摘要文本的字符上限（防止摘要本身撑爆预算）。 */
const MAX_SUMMARY_CHARS = 4000;

// ---------------------------------------------------------------------------
// compact 入参
// ---------------------------------------------------------------------------

/** compact / summarizePrefix 的可选项。 */
export type CompactOptions = {
  /** 模型总上下文（token），一般来自 ModelMeta.contextLimit；缺省用兜底。 */
  contextLimit?: number;
  /** 直接指定输入视图预算（token）。给定时优先于 contextLimit 推导（便于测试压小）。 */
  maxContextTokens?: number;
  /** 单条 tool_result 输出字符上限。 */
  maxToolChars?: number;
  /** 至少逐字保留的最近消息条数。 */
  keepRecent?: number;
  /** 摘要注入钩子：给定则用它替代内置的确定性结构摘要（未来可换 LLM）。 */
  summarize?: (dropped: Message[]) => string;
};

// ---------------------------------------------------------------------------
// token 估算
// ---------------------------------------------------------------------------

/** 单个 content part 的「计费字符数」（近似 wire 载荷，含结构开销由外层加）。 */
function partChars(part: ContentPart): number {
  switch (part.type) {
    case "text":
      return part.text.length;
    case "thinking":
      // 思考块不回传给模型，但仍占本地视图；计入偏保守（宁可早压缩）。
      return part.text.length;
    case "tool_call":
      return part.name.length + safeJson(part.args).length;
    case "tool_result":
      return part.output.length;
    default:
      return 0;
  }
}

/**
 * 估算一组消息的 token 数（启发式，约 4 字符/token）。
 * 纯函数：只读入参，返回整数。
 */
export function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const message of messages) {
    chars += MESSAGE_OVERHEAD_CHARS;
    for (const part of message.content) {
      chars += partChars(part) + PART_OVERHEAD_CHARS;
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

// ---------------------------------------------------------------------------
// 第一级：裁剪超大 tool_result 输出
// ---------------------------------------------------------------------------

/** 把超长输出裁成「头 + 省略标记 + 尾」；未超限原样返回。 */
function truncateOutput(output: string, maxChars: number): string {
  if (output.length <= maxChars) {
    return output;
  }
  const omitted = output.length - maxChars;
  const headLen = Math.ceil(maxChars / 2);
  const tailLen = maxChars - headLen;
  const head = output.slice(0, headLen);
  const tail = tailLen > 0 ? output.slice(output.length - tailLen) : "";
  return `${head}\n…[已省略 ${omitted} 字符]…\n${tail}`;
}

/**
 * 裁剪所有超大 tool_result 的 output（保留头+尾，中间标记省略）。
 * 非破坏：返回新数组；未变化的消息/块按引用复用（数据不可变，安全）。
 */
export function truncateToolOutputs(
  messages: Message[],
  maxToolChars: number = DEFAULT_MAX_TOOL_CHARS,
): Message[] {
  return messages.map((message) => {
    let changed = false;
    const content = message.content.map((part) => {
      if (part.type === "tool_result" && part.output.length > maxToolChars) {
        changed = true;
        return { ...part, output: truncateOutput(part.output, maxToolChars) };
      }
      return part;
    });
    return changed ? { role: message.role, content } : message;
  });
}

// ---------------------------------------------------------------------------
// 第二级：把最旧前缀折叠成一条摘要消息
// ---------------------------------------------------------------------------

/** 角色中文标签。 */
function roleLabel(role: Role): string {
  switch (role) {
    case "user":
      return "用户";
    case "assistant":
      return "助手";
    case "system":
      return "系统";
    default:
      return String(role);
  }
}

/** 折成单行并截断到片段上限。 */
function snippet(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > SUMMARY_SNIPPET_CHARS
    ? `${oneLine.slice(0, SUMMARY_SNIPPET_CHARS)}…`
    : oneLine;
}

/**
 * 为一段（将被丢弃的）消息前缀生成摘要文本。
 * 默认走「确定性结构摘要」：逐条拼接截断文本，标注角色与工具名，离线可测。
 * 若提供 summarize 钩子则改用之（未来可换 LLM 摘要）。纯函数。
 */
export function summarizePrefix(messages: Message[], opts?: Pick<CompactOptions, "summarize">): string {
  if (opts?.summarize) {
    return opts.summarize(messages);
  }

  // callId -> tool 名映射，用于给 tool_result 标注它对应的工具。
  const callName = new Map<string, string>();
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type === "tool_call") {
        callName.set(part.id, part.name);
      }
    }
  }

  const lines: string[] = [
    `[前文摘要] 以下 ${messages.length} 条较早消息已折叠以节省上下文，仅保留要点：`,
  ];
  for (const message of messages) {
    for (const part of message.content) {
      switch (part.type) {
        case "text": {
          const t = part.text.trim();
          if (t) {
            lines.push(`- ${roleLabel(message.role)}：${snippet(t)}`);
          }
          break;
        }
        case "tool_call":
          lines.push(`- 调用工具 ${part.name}(${snippet(safeJson(part.args))})`);
          break;
        case "tool_result": {
          const name = callName.get(part.callId) ?? "工具";
          const flag = part.isError ? "（失败）" : "";
          lines.push(`- ${name} 结果${flag}：${snippet(part.output)}`);
          break;
        }
        case "thinking":
          // 思考不纳入摘要正文（本就不回传给模型）。
          break;
        default:
          break;
      }
    }
  }

  const text = lines.join("\n");
  return text.length > MAX_SUMMARY_CHARS
    ? `${text.slice(0, MAX_SUMMARY_CHARS)}\n…[摘要过长已截断]…`
    : text;
}

/** 把摘要文本包成一条 user 文本消息。 */
function summaryMessage(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

/**
 * 判断在下标 k 处折叠（丢弃 [0,k)，保留 [k,n)）是否 orphan 安全：
 * 保留段里绝不能出现「配对的 tool_call 落在被丢弃前缀」的 tool_result（反之亦然）。
 * 由于 tool_result 恒在其 tool_call 之后，实践中唯一风险是「保留段的 tool_result
 * 配对到前缀里的 tool_call」；此处两个方向都查，稳妥。
 */
function isOrphanSafeFold(messages: Message[], k: number): boolean {
  const prefixCallIds = new Set<string>();
  const prefixResultIds = new Set<string>();
  for (let i = 0; i < k; i += 1) {
    for (const part of messages[i].content) {
      if (part.type === "tool_call") {
        prefixCallIds.add(part.id);
      } else if (part.type === "tool_result") {
        prefixResultIds.add(part.callId);
      }
    }
  }
  for (let i = k; i < messages.length; i += 1) {
    for (const part of messages[i].content) {
      if (part.type === "tool_result" && prefixCallIds.has(part.callId)) {
        return false; // 保留段有孤儿 tool_result（其 tool_call 已被折叠）
      }
      if (part.type === "tool_call" && prefixResultIds.has(part.id)) {
        return false; // 保留段有孤儿 tool_call（其 tool_result 已被折叠）
      }
    }
  }
  return true;
}

/**
 * 计算「压缩视图」：先裁剪超大 tool_result，若仍超预算再把最旧前缀折叠成一条摘要。
 *
 * 非破坏：入参 messages 完全只读，返回全新的视图数组。
 * Orphan 安全：折叠边界只落在 assistant 消息处且经 isOrphanSafeFold 校验，
 *   保证摘要+保留段里 tool_call / tool_result 严格配对，且与 user 摘要保持角色交替。
 */
export function compact(messages: Message[], opts?: CompactOptions): Message[] {
  const maxToolChars = opts?.maxToolChars ?? DEFAULT_MAX_TOOL_CHARS;
  // 下限钳到 1：keepRecent<=0 会让 maxFold>=n，折叠循环访问 truncated[n] 越界崩溃；
  // 且「一条最近消息都不逐字保留」本就违背设计意图（视图至少留 摘要+最近一条）。
  const keepRecent = Math.max(1, opts?.keepRecent ?? DEFAULT_KEEP_RECENT);
  const contextLimit = opts?.contextLimit ?? DEFAULT_CONTEXT_LIMIT;
  const budget =
    opts?.maxContextTokens ?? Math.max(MIN_BUDGET_TOKENS, contextLimit - OUTPUT_RESERVE_TOKENS);

  // 第一级：裁剪超大 tool_result（非破坏，产出新视图）。
  const truncated = truncateToolOutputs(messages, maxToolChars);

  // 未超预算：直接返回裁剪视图。
  if (estimateTokens(truncated) <= budget) {
    return truncated;
  }

  const n = truncated.length;
  // 至多折叠到 n - keepRecent，保证最近 keepRecent 条逐字保留。
  const maxFold = Math.max(0, n - keepRecent);
  if (maxFold === 0) {
    return truncated; // 太短，无法安全折叠
  }

  // 收集候选干净边界（升序）：切点须为 assistant 消息（折叠掉完整的 user 收尾+保证角色交替），
  // 且经 orphan 校验。
  const cleanBoundaries: number[] = [];
  for (let k = 1; k <= maxFold; k += 1) {
    if (truncated[k].role === "assistant" && isOrphanSafeFold(truncated, k)) {
      cleanBoundaries.push(k);
    }
  }
  if (cleanBoundaries.length === 0) {
    return truncated; // 找不到干净边界，宁可不折叠也不产出非法视图
  }

  // 优先：折叠最少、且能降到预算内的边界（信息损失最小）。
  // token 随折叠量单调下降（摘要有上限），升序首个满足即为最小折叠。
  for (const k of cleanBoundaries) {
    const summaryText = summarizePrefix(truncated.slice(0, k), { summarize: opts?.summarize });
    const view = [summaryMessage(summaryText), ...truncated.slice(k)];
    if (estimateTokens(view) <= budget) {
      return view;
    }
  }

  // 尽力而为：即便折叠最多也降不到预算内（预算过小/最近消息过大），
  // 折叠最大的干净边界以最大限度减负；结果仍是 orphan 安全的合法视图。
  const maxK = cleanBoundaries[cleanBoundaries.length - 1];
  const summaryText = summarizePrefix(truncated.slice(0, maxK), { summarize: opts?.summarize });
  return [summaryMessage(summaryText), ...truncated.slice(maxK)];
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/** 安全序列化任意值（不可序列化时退化为 String）。 */
function safeJson(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
