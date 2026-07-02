import type { ProviderConfig, ProviderFormat } from "../runtime/types.js";

export type SanitizedProvider = Omit<ProviderConfig, "apiKey"> & {
  /** 是否已配置密钥（显式或环境变量可解析），不回传明文。 */
  hasKey: boolean;
  apiKeyMasked: string | null;
};

const FORMATS: ProviderFormat[] = ["openai-chat", "openai-responses", "anthropic"];

/**
 * 管理 API provider 配置：增删改查、密钥解析、脱敏展示。
 * 只支持三种 wire format。
 */
export class ProviderStore {
  private providers: ProviderConfig[];

  constructor(
    initial: ProviderConfig[] = [],
    private readonly onChange: (providers: ProviderConfig[]) => void = () => {},
  ) {
    this.providers = initial.filter((item) => FORMATS.includes(item.format)).map(normalize);
  }

  list(): ProviderConfig[] {
    return this.providers.map((item) => ({ ...item }));
  }

  listSanitized(): SanitizedProvider[] {
    return this.providers.map((provider) => {
      const key = this.resolveKey(provider);
      return {
        id: provider.id,
        label: provider.label,
        format: provider.format,
        baseUrl: provider.baseUrl,
        apiKeyEnv: provider.apiKeyEnv,
        models: [...provider.models],
        hasKey: Boolean(key),
        apiKeyMasked: maskKey(provider.apiKey),
      };
    });
  }

  get(id: string): ProviderConfig | undefined {
    const found = this.providers.find((item) => item.id === id);
    return found ? { ...found } : undefined;
  }

  /** 解析 provider 实际使用的密钥：优先环境变量，其次显式配置。 */
  resolveKey(provider: ProviderConfig): string | undefined {
    if (provider.apiKeyEnv) {
      const fromEnv = process.env[provider.apiKeyEnv];
      if (fromEnv && fromEnv.trim()) {
        return fromEnv.trim();
      }
    }
    return provider.apiKey?.trim() || undefined;
  }

  upsert(input: Partial<ProviderConfig> & { id: string }): ProviderConfig {
    const id = input.id.trim();
    if (!id) {
      throw new Error("provider id 不能为空");
    }
    const format = input.format && FORMATS.includes(input.format) ? input.format : undefined;
    if (!format) {
      throw new Error("format 必须是 openai-chat / openai-responses / anthropic 之一");
    }
    const existing = this.providers.find((item) => item.id === id);
    const next = normalize({
      id,
      label: input.label ?? existing?.label,
      format,
      baseUrl: input.baseUrl ?? existing?.baseUrl,
      apiKeyEnv: input.apiKeyEnv ?? existing?.apiKeyEnv,
      // 空字符串表示"保持不变"，让前端不必回传明文
      apiKey: input.apiKey === undefined || input.apiKey === "" ? existing?.apiKey : input.apiKey,
      models: Array.isArray(input.models) ? input.models : existing?.models ?? [],
    });
    this.providers = existing
      ? this.providers.map((item) => (item.id === id ? next : item))
      : [...this.providers, next];
    this.onChange(this.list());
    return { ...next };
  }

  remove(id: string): boolean {
    const before = this.providers.length;
    this.providers = this.providers.filter((item) => item.id !== id);
    const removed = this.providers.length !== before;
    if (removed) {
      this.onChange(this.list());
    }
    return removed;
  }
}

function normalize(provider: ProviderConfig): ProviderConfig {
  return {
    id: provider.id.trim(),
    label: provider.label?.trim() || undefined,
    format: provider.format,
    baseUrl: provider.baseUrl?.trim() || undefined,
    apiKeyEnv: provider.apiKeyEnv?.trim() || undefined,
    apiKey: provider.apiKey?.trim() || undefined,
    models: dedupe(
      (provider.models ?? [])
        .map((model) => String(model).trim())
        .filter((model) => model.length > 0),
    ),
  };
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

function maskKey(key: string | undefined): string | null {
  if (!key) {
    return null;
  }
  if (key.length <= 8) {
    return "••••";
  }
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}
