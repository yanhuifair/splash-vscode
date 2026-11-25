/** splash.thinkingLevels 里允许的值:字符串级别,或 true=服务端默认 / false=关闭思考。 */
export type ThinkingLevelValue = string | boolean;

/** 配置里只允许字符串与布尔值,其它类型直接丢掉。 */
export function readThinkingLevels(value: unknown): Record<string, ThinkingLevelValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const result: Record<string, ThinkingLevelValue> = {};
  for (const [modelId, level] of Object.entries(value)) {
    if (typeof level === 'string' || typeof level === 'boolean') {
      result[modelId] = level;
    }
  }
  return result;
}

export interface ThinkingResolution {
  /** 真正下发的 reasoning_effort;undefined 表示不发送该参数。 */
  readonly level?: string;
  readonly source: 'model-option' | 'thinkingLevels' | 'global' | 'server';
  readonly configured?: ThinkingLevelValue;
  readonly supported: boolean;
  readonly note: string;
}

function normalizeLevel(value: unknown): string | undefined {
  if (value === true) {
    return 'server';
  }
  if (value === false) {
    return 'none';
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  return undefined;
}

/**
 * 优先级:调用方 modelOptions > splash.thinkingLevels[完整模型 ID] > splash.reasoningEffort。
 * `server` / true = 不下发,交给服务端默认;`none` / false = 明确关闭思考。
 * 模型声明了 efforts 时只下发声明过的值(`none` 例外,splash 接受它来关闭思考)。
 */
export function resolveThinkingLevel(
  modelId: string,
  modelOptions: unknown,
  thinkingLevels: Readonly<Record<string, ThinkingLevelValue>>,
  globalEffort: string,
  efforts: readonly string[]
): ThinkingResolution {
  const option = normalizeLevel((modelOptions as { reasoningEffort?: unknown; reasoning_effort?: unknown } | undefined)?.reasoningEffort)
    ?? normalizeLevel((modelOptions as { reasoning_effort?: unknown } | undefined)?.reasoning_effort);
  const hasConfigured = Object.prototype.hasOwnProperty.call(thinkingLevels, modelId);
  const configured = hasConfigured ? thinkingLevels[modelId] : undefined;
  const configuredLevel = hasConfigured ? normalizeLevel(configured) : undefined;

  let level: string | undefined;
  let source: ThinkingResolution['source'];
  if (option) {
    level = option;
    source = 'model-option';
  } else if (configuredLevel) {
    level = configuredLevel;
    source = 'thinkingLevels';
  } else {
    level = normalizeLevel(globalEffort);
    source = level ? 'global' : 'server';
  }

  if (!level || level === 'server') {
    return {
      source,
      configured,
      supported: true,
      note: `${modelId}: 思考强度 ${level === 'server' ? 'server(服务端默认)' : '未指定'},来源 ${source}`
    };
  }
  if (level === 'none') {
    return {
      level,
      source,
      configured,
      supported: true,
      note: `${modelId}: 思考强度 none(关闭),来源 ${source}`
    };
  }
  if (efforts.length && !efforts.includes(level)) {
    return {
      source,
      configured,
      supported: false,
      note: `${modelId}: 忽略思考强度 ${level}(来源 ${source}),模型只声明 ${efforts.join('/') || '(无)'}`
    };
  }
  return {
    level,
    source,
    configured,
    supported: true,
    note: `${modelId}: 思考强度 ${level},来源 ${source}`
  };
}
