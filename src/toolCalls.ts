export interface RawToolCall {
  id?: string;
  name?: string;
  args: string;
}

export interface OfferedTool {
  name: string;
  schema?: object;
}

export interface ResolvedToolCall {
  callId: string;
  name: string;
  input: Record<string, unknown>;
  repaired: boolean;
}

export interface SkippedToolCall {
  name: string;
  args: string;
  reason: string;
}

export interface ResolvedToolCalls {
  calls: ResolvedToolCall[];
  skipped: SkippedToolCall[];
}

/**
 * Turns the raw tool-call deltas from splash into tool calls VS Code can actually run:
 * unknown tools, unparsable arguments and missing required arguments would otherwise
 * surface as broken or permanently pending tool confirmations.
 */
export function resolveToolCalls(records: readonly RawToolCall[], offered: readonly OfferedTool[]): ResolvedToolCalls {
  const exact = new Map<string, OfferedTool>();
  const loose = new Map<string, OfferedTool | null>();
  for (const tool of offered) {
    if (!tool.name) {
      continue;
    }
    exact.set(tool.name, tool);
    const key = normalizeName(tool.name);
    const existing = loose.get(key);
    loose.set(key, existing === undefined ? tool : existing?.name === tool.name ? tool : null);
  }

  const calls: ResolvedToolCall[] = [];
  const skipped: SkippedToolCall[] = [];
  const usedIds = new Set<string>();
  const seen = new Map<string, ResolvedToolCall>();

  for (const record of records) {
    const rawName = (record.name ?? '').trim();
    if (!rawName) {
      skipped.push({ name: '(无名)', args: record.args, reason: '模型没有返回工具名' });
      continue;
    }
    const tool = exact.get(rawName) ?? loose.get(normalizeName(rawName)) ?? undefined;
    if (!tool) {
      skipped.push({ name: rawName, args: record.args, reason: `不在本次提供的工具列表里(${offered.length} 个工具)` });
      continue;
    }

    const parsed = parseArgs(record.args);
    if (!parsed) {
      skipped.push({ name: tool.name, args: record.args, reason: '参数不是合法 JSON,修复后仍无法解析' });
      continue;
    }

    const missing = missingRequired(tool.schema, parsed.value);
    if (missing.length) {
      skipped.push({ name: tool.name, args: record.args, reason: `缺少必需参数: ${missing.join(', ')}` });
      continue;
    }

    const dedupeKey = `${tool.name}\u0000${stableKey(parsed.value)}`;
    const duplicate = seen.get(dedupeKey);
    if (duplicate) {
      skipped.push({ name: tool.name, args: record.args, reason: `与同一个回复里的另一次调用完全相同(id ${duplicate.callId})` });
      continue;
    }

    const callId = uniqueCallId(record.id, usedIds);
    const call: ResolvedToolCall = { callId, name: tool.name, input: parsed.value, repaired: parsed.repaired };
    seen.set(dedupeKey, call);
    calls.push(call);
  }

  return { calls, skipped };
}

/**
 * 先按原样解析,失败后才花力气修:之前的实现一上来就把所有候选(每个引号/括号都
 * 生成一份「补齐版」)全部构造出来,合法的 60 KB 参数也要跑 1.3 秒,直接卡住扩展主机。
 */
export function parseArgs(args: string): { value: Record<string, unknown>; repaired: boolean } | undefined {
  const trimmed = (args ?? '').trim();
  if (!trimmed) {
    return { value: {}, repaired: false };
  }

  const direct = parseObject(trimmed);
  if (direct) {
    return { value: direct, repaired: false };
  }

  for (const candidate of repairCandidates(trimmed)) {
    const value = parseObject(candidate);
    if (value) {
      return { value, repaired: true };
    }
  }
  return undefined;
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // 交给上层继续尝试下一个候选
  }
  return undefined;
}

/** 最多尝试这么多个截断点,避免长参数的修复成本再次随长度爆炸。 */
const MAX_TRUNCATION_ATTEMPTS = 24;

function repairCandidates(trimmed: string): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>([trimmed]);
  const push = (candidate: string) => {
    if (!seen.has(candidate)) {
      seen.add(candidate);
      candidates.push(candidate);
    }
  };

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  // 代码块或前后夹了说明文字:截出 JSON 主体。
  if (firstBrace > 0) {
    push(trimmed.slice(firstBrace));
  }
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  // A stream cut off by max_tokens leaves half-written JSON behind; close the
  // open string/brackets, and if that is not enough fall back to earlier value
  // boundaries so the complete part of the arguments survives.
  push(closeJson(trimmed));
  let attempts = 0;
  for (let index = trimmed.length - 1; index >= 0 && attempts < MAX_TRUNCATION_ATTEMPTS; index -= 1) {
    if (!'"}]:,'.includes(trimmed[index])) {
      continue;
    }
    attempts += 1;
    push(closeJson(trimmed.slice(0, index + 1)));
  }
  return candidates;
}

function closeJson(prefix: string): string {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const char of prefix) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{' || char === '[') {
      stack.push(char);
    } else if (char === '}' || char === ']') {
      stack.pop();
    }
  }

  let text = inString ? `${prefix}"` : prefix;
  text = text.replace(/[,:[\s]+$/, '');
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    text += stack[index] === '{' ? '}' : ']';
  }
  return text;
}

function missingRequired(schema: object | undefined, input: Record<string, unknown>): string[] {
  return [...new Set(checkSchema(schema, input))];
}

/**
 * JSON Schema 里必需字段的组合语义:allOf 全部满足,anyOf/oneOf 满足一个分支即可。
 * 只检查顶层字段,拿不准时宁可放过(残缺参数交给工具自己报错)。
 */
function checkSchema(node: unknown, input: Record<string, unknown>): string[] {
  if (!node || typeof node !== 'object') {
    return [];
  }
  const candidate = node as Record<string, unknown>;
  const required = Array.isArray(candidate.required) ? candidate.required : [];
  const missing = required.filter((key) => typeof key === 'string' && (input[key] === undefined || input[key] === null));

  if (Array.isArray(candidate.allOf)) {
    for (const branch of candidate.allOf) {
      missing.push(...checkSchema(branch, input));
    }
  }

  const branches = Array.isArray(candidate.anyOf) ? candidate.anyOf : Array.isArray(candidate.oneOf) ? candidate.oneOf : undefined;
  if (branches?.length) {
    const best = branches
      .map((branch) => checkSchema(branch, input))
      .reduce((shortest, current) => (current.length < shortest.length ? current : shortest));
    missing.push(...best);
  }
  return missing;
}

function uniqueCallId(id: string | undefined, used: Set<string>): string {
  const base = (id ?? '').trim() || `call_${Math.random().toString(36).slice(2, 10)}`;
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function stableKey(value: Record<string, unknown>): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}
