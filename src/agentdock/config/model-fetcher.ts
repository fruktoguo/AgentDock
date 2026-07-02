import type { ProviderFormat } from "../runtime/types.js";

export type FetchModelsInput = {
  format: ProviderFormat;
  /** 已由调用方解析好的有效密钥（非空）。本模块不再解析环境变量。 */
  apiKey: string;
  /** 原始 baseUrl（可空），内部做归一化。 */
  baseUrl?: string;
  /** 覆盖默认 15s。可选。 */
  timeoutMs?: number;
};

/** 上游返回非 2xx 时抛出，server 据此映射为 502。message 已确保不含 key。 */
export class UpstreamModelError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "UpstreamModelError";
  }
}

/**
 * 按 format 请求上游模型目录，返回去重、去空、保持上游顺序的 model id 列表。
 * - 成功：string[]
 * - 上游非 2xx：抛 UpstreamModelError（message = "上游 <status>: <简短错误>"，不含 key）
 * - 网络/超时/解析失败：抛普通 Error（server 兜底为 502 或 500）
 */
export async function fetchProviderModels(input: FetchModelsInput): Promise<string[]> {
  const { format, apiKey } = input;
  const url = normalizeModelsUrl(input.baseUrl, format);
  const headers = buildHeaders(format, apiKey);

  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), input.timeoutMs ?? 15_000);
  try {
    const response = await fetch(url, { method: "GET", headers, signal: ac.signal });
    if (!response.ok) {
      const raw = await response.text().catch(() => "");
      const short = raw.slice(0, 300);
      throw new UpstreamModelError(`上游 ${response.status}: ${short}`, 502);
    }
    const json = (await response.json()) as { data?: unknown };
    const raw = Array.isArray(json?.data) ? json.data : [];
    const ids: string[] = [];
    for (const item of raw) {
      const id = (item as { id?: unknown })?.id;
      if (typeof id === "string") {
        ids.push(id);
      }
    }
    return dedupe(ids);
  } finally {
    clearTimeout(timeout);
  }
}

/** 复用与 api-driver 一致的头部形态：openai 用 Bearer，anthropic 用 x-api-key。 */
function buildHeaders(format: ProviderFormat, apiKey: string): Record<string, string> {
  if (format === "anthropic") {
    return { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
  }
  return { Authorization: `Bearer ${apiKey}` };
}

/**
 * baseUrl 归一化：空 → format 默认 base；去尾斜杠；
 * 已以 /models 结尾直接用，否则一律 append /models。
 */
function normalizeModelsUrl(baseUrl: string | undefined, format: ProviderFormat): string {
  const fallback = format === "anthropic" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1";
  const raw = baseUrl?.trim();
  const base = (raw && raw.length > 0 ? raw : fallback).replace(/\/+$/, "");
  if (base.endsWith("/models")) {
    return base;
  }
  return `${base}/models`;
}

/** 去重、保持上游顺序（输入已保证是 string）。 */
function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length > 0 && !seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }
  return result;
}
