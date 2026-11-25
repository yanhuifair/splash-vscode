import type { SplashTimeouts } from './client';

/** `/status` 里跟超时相关的部分(splash 1.6+;字段缺失时用兜底值)。 */
export interface SplashStatus {
  ready?: boolean;
  admission?: { waiting?: number; waiting_concurrency?: number; waiting_memory?: number };
  scheduler?: { queued?: number; waiting_resources?: number };
  weights?: { idle_release_seconds?: number; released?: boolean; restoring?: boolean; restores?: number };
  http?: { requests?: { active?: number; capacity?: number } };
  latency?: { http_request?: { count?: number; sum?: number } };
  capabilities?: { max_context_tokens?: number };
}

interface DerivedTimeouts {
  connectMs: number;
  idleMs: number;
  connectNote: string;
  idleNote: string;
}

/**
 * VS Code 侧默认不重复配置超时,而是从服务自己的状态推导:
 * 0 = 跟随服务(默认),-1 = 完全关闭该项,>0 = 手动固定。
 */
export function deriveTimeouts(
  settings: { connectTimeoutMs: number; idleTimeoutMs: number; requestTimeoutMs: number },
  status: SplashStatus | undefined
): SplashTimeouts & { notes: string[] } {
  const notes: string[] = [];
  const derived = status ? derivedFromStatus(status) : undefined;
  const missing = '没有拿到 /status,用内置兜底';

  const connectMs = pick(settings.connectTimeoutMs, derived?.connectMs ?? FALLBACK_CONNECT_MS, notes, 'connectTimeoutMs', derived?.connectNote ?? missing);
  const idleMs = pick(settings.idleTimeoutMs, derived?.idleMs ?? FALLBACK_IDLE_MS, notes, 'idleTimeoutMs', derived?.idleNote ?? missing);
  // 总时长:0(跟随服务)= 不限制,让 --request-timeout 决定并回 504。
  const totalMs = Math.max(0, settings.requestTimeoutMs);

  return { connectMs, idleMs, totalMs, notes };
}

/** 只有真正采用了推导值才写日志,否则会把「被设置覆盖掉」的值也打出来误导人。 */
function pick(settingValue: number, derivedValue: number, notes: string[], name: string, reason: string): number {
  if (settingValue < 0) {
    notes.push(`${name} 已关闭(不限制)`);
    return 0;
  }
  if (settingValue > 0) {
    return settingValue;
  }
  notes.push(`${name}=${derivedValue}ms(${reason})`);
  return derivedValue;
}

const FALLBACK_CONNECT_MS = 120_000;
const FALLBACK_IDLE_MS = 600_000;
const MIN_CONNECT_MS = 30_000;
const RELOAD_CONNECT_MS = 180_000;
const QUEUE_STEP_MS = 15_000;
const MAX_CONNECT_MS = 900_000;
const MIN_IDLE_MS = 300_000;
const MAX_IDLE_MS = 1_800_000;

function derivedFromStatus(status: SplashStatus): DerivedTimeouts {
  const waiting = (status.admission?.waiting ?? 0) + (status.scheduler?.queued ?? 0);
  const weights = status.weights ?? {};
  const unloading = weights.released === true || weights.restoring === true;
  const base = unloading ? RELOAD_CONNECT_MS : MIN_CONNECT_MS;
  const connectMs = Math.min(MAX_CONNECT_MS, base + waiting * QUEUE_STEP_MS);
  const connectNote = unloading
    ? `权重已卸载/正在恢复(idle-release ${weights.idle_release_seconds ?? '?'}s)`
    : waiting > 0
      ? `${waiting} 个请求在排队`
      : '服务已就绪';

  const latency = status.latency?.http_request;
  const count = latency?.count ?? 0;
  const meanMs = count > 0 && latency?.sum ? (latency.sum * 1_000) / count : 0;
  const idleMs = meanMs > 0 ? clamp(meanMs * 5, MIN_IDLE_MS, MAX_IDLE_MS) : FALLBACK_IDLE_MS;
  const idleNote = meanMs > 0 ? `历史请求平均 ${Math.round(meanMs)}ms 的 5 倍` : '没有历史耗时数据';

  return { connectMs, idleMs, connectNote, idleNote };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
