/** VS Code「管理模型」里某一个 Splash 配置组的设置。 */
export interface ProviderGroupConfig {
  readonly url?: string;
  readonly models?: readonly string[];
  readonly headers?: Readonly<Record<string, string>>;
  /** package.json 里标记 secret: true,由 VS Code 安全存储。 */
  readonly apiKey?: string;
}

/**
 * options.configuration 是 VS Code 1.127+ 的 provider 配置组;
 * 公开 d.ts 还没声明这个字段,所以用鸭子类型读取。
 */
export function readProviderConfig(options: unknown): ProviderGroupConfig | undefined {
  const raw = (options as { readonly configuration?: unknown } | undefined)?.configuration;
  if (!isRecord(raw)) {
    return undefined;
  }
  const models = Array.isArray(raw.models)
    ? raw.models.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : [];
  return {
    url: typeof raw.url === 'string' && raw.url.trim() ? raw.url.trim() : undefined,
    models: models.length ? models : undefined,
    headers: isRecord(raw.headers) ? readStringRecord(raw.headers) : undefined,
    apiKey: typeof raw.apiKey === 'string' && raw.apiKey.trim() ? raw.apiKey.trim() : undefined
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function readStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry === 'string' && entry) {
      result[name] = entry;
    }
  }
  return result;
}

/** 配置组身份:API Key 只参与哈希,不会进日志或模型元数据。 */
export function groupKey(config: ProviderGroupConfig | undefined): string {
  if (!config) {
    return '';
  }
  const { url, models, headers, apiKey } = config;
  if (!url && !models?.length && !Object.keys(headers ?? {}).length && !apiKey) {
    return '';
  }
  return hashText(JSON.stringify({ url, models, headers, apiKey }));
}

/** 给缓存做 key:避免把整段长文本或密钥留在内存里。 */
export function hashText(text: string): string {
  let first = 0x811c9dc5;
  let second = 0x01000193;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second + code, 2246822519);
  }
  return `${text.length}:${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`;
}
