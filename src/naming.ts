export interface ModelLabel {
  name: string;
  family: string;
  variant?: string;
  /** 选择器 detail 里那个短标记,例如 `Q4_K_M`。 */
  badge?: string;
}

/**
 * `unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M` → name `Qwen3.8-27B`,badge `Q4_K_M`。
 * 名字保持一致、量化档和上下文放进 detail,选择器里才分得清同系列的不同量化。
 */
export function displayLabel(id: string): ModelLabel {
  const [repo, ...rest] = id.split(':');
  const variant = rest.length ? rest.join(':') : undefined;
  const base = (repo.split('/').pop() ?? repo).replace(/-gguf$/i, '');
  return {
    name: base || id,
    family: base.toLowerCase() || id.toLowerCase(),
    variant,
    badge: variant ? shortVariant(variant) : undefined
  };
}

/** `UD-Q4_K_M` → `Q4_K_M`;提取不到量化(如 `instruct`)就原样返回。 */
export function shortVariant(variant: string): string {
  const match = /(?:^|[^A-Za-z0-9])((?:UD-)?(?:I?Q\d[A-Z0-9_]*)|F16|FP16|BF16|F32)(?:$|[^A-Za-z0-9])/i.exec(variant);
  if (!match) {
    return variant;
  }
  return match[1].toUpperCase().replace(/^UD-/, '');
}

export function shortContext(tokens: number): string {
  if (tokens >= 1024) {
    return `${Math.round(tokens / 1024)}k`;
  }
  return String(tokens);
}
