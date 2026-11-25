export interface SplashReasoningInfo {
  readonly thinks?: boolean;
  readonly efforts?: readonly string[];
  readonly default?: string;
}

export interface SplashModelDescription {
  readonly id: string;
  readonly created?: number;
  readonly owned_by?: string;
  readonly max_model_len?: number;
  readonly context_length?: number;
  readonly vision?: boolean;
  readonly input_modalities?: readonly string[];
  readonly reasoning?: SplashReasoningInfo;
}

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatTextPart {
  readonly type: 'text';
  readonly text: string;
}

export interface ChatImagePart {
  readonly type: 'image_url';
  readonly image_url: { readonly url: string };
}

/** OpenAI 兼容的 PDF 输入:splash 把 file_data 渲染成文本 + 每页图片。 */
export interface ChatFilePart {
  readonly type: 'file';
  readonly file: { readonly file_data: string };
}

export type ChatContentPart = ChatTextPart | ChatImagePart | ChatFilePart;

export interface ChatToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: { readonly name: string; readonly arguments: string };
}

export interface ChatMessage {
  role: ChatRole;
  content?: string | ChatContentPart[] | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ChatToolSpec {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description?: string;
    readonly parameters?: unknown;
  };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ChatToolSpec[];
  tool_choice?: 'auto' | 'required' | 'none';
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  reasoning_effort?: string;
  stream?: boolean;
}

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface ToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  arguments?: string;
}

export interface StreamChunk {
  text?: string;
  reasoning?: string;
  toolCalls?: ToolCallDelta[];
  finishReason?: string | null;
  usage?: Usage;
}

export class SplashError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
    readonly statusCode?: number,
    /** 连接层就失败了(请求没发出去),重试是安全的。 */
    readonly retryable = false
  ) {
    super(message);
    this.name = 'SplashError';
  }
}

/** 404 用状态码判断,不在响应体里搜字符串(报错正文偶尔也含 "404")。 */
export function isNotFound(error: unknown): boolean {
  return error instanceof SplashError && error.statusCode === 404;
}

/**
 * fetch 被 AbortSignal 打断时抛的不一定是 AbortError:超时用的是 TimeoutError,
 * 两者都不能被当成「连不上 splash」。
 */
function isAbortLike(error: unknown): boolean {
  const candidate = error as { name?: string; code?: string } | undefined;
  return candidate?.name === 'AbortError' || candidate?.name === 'TimeoutError' || candidate?.code === 'ABORT_ERR';
}

export type TimeoutKind = 'connect' | 'idle' | 'total' | 'caller';

/** 请求被超时/取消打断;kind 决定了给用户看的那句话该怎么说。 */
export class SplashTimeoutError extends SplashError {
  constructor(readonly kind: TimeoutKind, readonly timeoutMs: number, message: string, detail?: string) {
    super(message, detail);
    this.name = 'SplashTimeoutError';
  }
}

export interface SplashTimeouts {
  /** 等待响应头(即服务开始应答)的上限。 */
  connectMs: number;
  /** 流式响应中相邻两块数据之间的最长间隔。 */
  idleMs: number;
  /** 单次请求总上限。 */
  totalMs: number;
}

/** 与 timeouts.ts 的兜底值保持一致,免得「有没有拿到 /status」变成两套默认。 */
const DEFAULT_TIMEOUTS: SplashTimeouts = { connectMs: 120_000, idleMs: 600_000, totalMs: 0 };


interface Attempt {
  readonly signal: AbortSignal;
  headersArrived(): void;
  activity(): void;
  kind(): TimeoutKind | undefined;
  dispose(): void;
}

export class SplashClient {
  constructor(
    baseUrl: string,
    private readonly apiKey?: string,
    private readonly timeouts: SplashTimeouts = DEFAULT_TIMEOUTS,
    private readonly headers: Readonly<Record<string, string>> = {}
  ) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  readonly baseUrl: string;

  async listModels(signal?: AbortSignal): Promise<SplashModelDescription[]> {
    const body = await this.request_json('/v1/models', { signal });
    const parsed = parseJson<{ data?: SplashModelDescription[] }>(body, 'GET /v1/models');
    return (parsed.data ?? []).filter((model) => typeof model?.id === 'string');
  }

  async health(signal?: AbortSignal): Promise<boolean> {
    try {
      const body = await this.request_json('/health', { signal });
      return parseJson<{ status?: string }>(body, 'GET /health').status === 'ok';
    } catch (error) {
      // 老版本 splash 没有 /health:404 也说明服务在线。
      if (isNotFound(error)) {
        return true;
      }
      throw error;
    }
  }

  /** 服务端自己的状态(排队、权重是否已卸载、历史耗时),用来推导客户端超时。 */
  async status(signal?: AbortSignal): Promise<unknown> {
    const body = await this.request_json('/status', { signal });
    return parseJson<unknown>(body, 'GET /status');
  }

  async countTokens(text: string, signal?: AbortSignal): Promise<number | undefined> {
    if (!text) {
      return 0;
    }
    try {
      const body = await this.request_json('/tokenize', {
        method: 'POST',
        body: JSON.stringify({ content: text, add_special: false }),
        signal
      });
      const tokens = parseJson<{ tokens?: unknown[] }>(body, 'POST /tokenize').tokens;
      return Array.isArray(tokens) ? tokens.length : undefined;
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw error;
    }
  }

  async streamChat(
    request: ChatRequest,
    onChunk: (chunk: StreamChunk) => void,
    signal?: AbortSignal
  ): Promise<void> {
    let includeUsage = true;
    let retriedConnection = false;
    // 最多三次:连接层重试一次(服务刚起来),stream_options 降级一次(老服务端)。
    // 两种重试可以叠加:连接重试后的第二次请求仍可能因 stream_options 被 400 拒绝。
    for (let attempt = 0; attempt < MAX_STREAM_ATTEMPTS; attempt += 1) {
      try {
        await this.streamOnce(request, onChunk, signal, includeUsage);
        return;
      } catch (error) {
        if (signal?.aborted) {
          throw error;
        }
        if (!retriedConnection && isTransientConnection(error)) {
          retriedConnection = true;
          await delay(RETRY_DELAY_MS);
          if (signal?.aborted) {
            throw error;
          }
          continue;
        }
        if (includeUsage && rejectsStreamOptions(error)) {
          includeUsage = false;
          continue;
        }
        throw error;
      }
    }
  }

  private async streamOnce(
    request: ChatRequest,
    onChunk: (chunk: StreamChunk) => void,
    signal: AbortSignal | undefined,
    includeUsage: boolean
  ): Promise<void> {
    const attempt = this.attempt(signal);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const payload = includeUsage
        ? { ...request, stream: true, stream_options: { include_usage: true } }
        : { ...request, stream: true };
      const response = await this.fetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.authHeaders() },
        body: JSON.stringify(payload),
        signal: attempt.signal
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new SplashError(
          `splash 返回了 ${response.status} ${response.statusText}`,
          `${response.status} ${body}`.trim(),
          response.status
        );
      }
      if (!response.body) {
        throw new SplashError('splash 返回了空响应。');
      }
      attempt.headersArrived();

      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          // 只有真正的数据块才算「有进展」。心跳(SSE 注释行)会一直来,
          // 若按字节到达续命,断流的请求就永远等不到 idle 超时。
          if (this.handleLine(line, onChunk)) {
            attempt.activity();
          }
          newline = buffer.indexOf('\n');
        }
      }
      buffer += decoder.decode();
      if (buffer.trim() && this.handleLine(buffer.trim(), onChunk)) {
        attempt.activity();
      }
    } catch (error) {
      throw this.classifyTimeout(error, attempt.kind(), 'POST /v1/chat/completions');
    } finally {
      reader?.releaseLock();
      attempt.dispose();
    }
  }

  /**
   * 一个请求的三段超时:连不上(响应头迟迟不来)、生成中途卡住(数据块断流)、总时长上限。
   * 三者对用户的含义完全不同,所以分别记录。
   */
  private attempt(signal: AbortSignal | undefined): Attempt {
    const controller = new AbortController();
    let kind: TimeoutKind | undefined;
    const abort = (why: TimeoutKind) => {
      if (kind) {
        return;
      }
      kind = why;
      controller.abort(why);
    };

    // 0 表示这一段不限制:交给 splash serve 自己的 --request-timeout(默认 none)决定。
    const connect = this.timeouts.connectMs > 0 ? this.timer(() => abort('connect'), this.timeouts.connectMs) : undefined;
    const total = this.timeouts.totalMs > 0 ? this.timer(() => abort('total'), this.timeouts.totalMs) : undefined;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const onCallerAbort = () => abort('caller');

    if (signal?.aborted) {
      abort('caller');
    } else {
      signal?.addEventListener('abort', onCallerAbort, { once: true });
    }

    return {
      signal: controller.signal,
      headersArrived: () => {
        clearTimeout(connect);
        this.resetIdle(idle, () => abort('idle'), (timer) => (idle = timer));
      },
      activity: () => {
        this.resetIdle(idle, () => abort('idle'), (timer) => (idle = timer));
      },
      kind: () => kind,
      dispose: () => {
        clearTimeout(connect);
        clearTimeout(total);
        if (idle) {
          clearTimeout(idle);
        }
        signal?.removeEventListener('abort', onCallerAbort);
      }
    };
  }

  /** 计时器不应阻止扩展主机进程退出,所以 unref 掉。 */
  private timer(onTimeout: () => void, ms: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(onTimeout, ms);
    (timer as { unref?: () => void }).unref?.();
    return timer;
  }

  private resetIdle(
    current: ReturnType<typeof setTimeout> | undefined,
    onTimeout: () => void,
    store: (timer: ReturnType<typeof setTimeout>) => void
  ): void {
    if (current) {
      clearTimeout(current);
    }
    if (this.timeouts.idleMs > 0) {
      store(this.timer(onTimeout, this.timeouts.idleMs));
    }
  }

  private classifyTimeout(error: unknown, kind: TimeoutKind | undefined, target: string): unknown {
    if (!kind) {
      return error;
    }
    if (kind === 'caller') {
      return error;
    }
    const limit = kind === 'connect' ? this.timeouts.connectMs : kind === 'idle' ? this.timeouts.idleMs : this.timeouts.totalMs;
    const setting = kind === 'connect' ? 'splash.connectTimeoutMs' : kind === 'idle' ? 'splash.idleTimeoutMs' : 'splash.requestTimeoutMs';
    const message =
      kind === 'connect'
        ? `splash 在 ${limit} ms 内没有应答(${target}),服务可能在加载模型或被其他请求占用。可加大 ${setting}。`
        : kind === 'idle'
          ? `splash 在 ${limit} ms 内没有新输出(${target}),生成太慢或被排队。可加大 ${setting}。`
          : `splash 请求超过 ${limit} ms 被中断(${target})。可加大 ${setting}。`;
    const cause = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return new SplashTimeoutError(kind, limit, message, `超时中断 kind=${kind};底层错误 ${cause}`);
  }
  /** 返回是否产出了真正可用的数据块(决定要不要续 idle 计时)。 */
  private handleLine(line: string, onChunk: (chunk: StreamChunk) => void): boolean {
    if (!line.startsWith('data:')) {
      return false;
    }
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') {
      return false;
    }
    let parsed: RawChunk;
    try {
      parsed = JSON.parse(payload) as RawChunk;
    } catch {
      return false;
    }
    const choice = parsed.choices?.[0];
    const delta = choice?.delta;
    const chunk: StreamChunk = {};
    if (typeof delta?.content === 'string' && delta.content.length > 0) {
      chunk.text = delta.content;
    }
    const reasoning = delta?.reasoning_content ?? delta?.reasoning;
    if (typeof reasoning === 'string' && reasoning.length > 0) {
      chunk.reasoning = reasoning;
    }
    if (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0) {
      chunk.toolCalls = delta.tool_calls.map((call, position) => ({
        index: typeof call.index === 'number' ? call.index : position,
        id: typeof call.id === 'string' ? call.id : undefined,
        name: call.function?.name,
        arguments: call.function?.arguments
      }));
    }
    if (choice?.finish_reason) {
      chunk.finishReason = choice.finish_reason;
    }
    if (parsed.usage) {
      chunk.usage = parsed.usage;
    }
    if (chunk.text || chunk.reasoning || chunk.toolCalls || chunk.finishReason || chunk.usage) {
      onChunk(chunk);
      return true;
    }
    return false;
  }

  private async request_json(path: string, init: RequestInit): Promise<string> {
    const attempt = this.attempt(init.signal ?? undefined);
    try {
      const response = await this.fetch(path, {
        ...init,
        signal: attempt.signal,
        headers: {
          'content-type': 'application/json',
          ...this.authHeaders(),
          ...(init.headers as Record<string, string> | undefined)
        }
      });
      attempt.headersArrived();
      const text = await response.text();
      if (!response.ok) {
        throw new SplashError(
          `splash 请求失败: ${response.status} ${response.statusText}`,
          `${response.status} ${text}`,
          response.status
        );
      }
      return text;
    } catch (error) {
      throw this.classifyTimeout(error, attempt.kind(), `${init.method ?? 'GET'} ${path}`);
    } finally {
      attempt.dispose();
    }
  }

  private async fetch(path: string, init: RequestInit): Promise<Response> {
    try {
      return await globalThis.fetch(this.baseUrl + path, init);
    } catch (error) {
      // 被超时/取消打断时,undici 抛的可能是 TypeError(fetch failed) 而不是 AbortError,
      // 所以这里还要看 signal 是否已经 aborted,否则会误报成「连不上 splash」。
      if (isAbortLike(error) || init.signal?.aborted) {
        throw error;
      }
      throw new SplashError(
        `无法连接 splash (${this.baseUrl})。请先运行 splash serve,或在设置里修改 splash.baseUrl。`,
        String((error as Error)?.cause ?? error),
        undefined,
        true
      );
    }
  }

  /** 配置组里的自定义 header 先放进去;API Key 最后写入,避免被同名 header 覆盖。 */
  private authHeaders(): Record<string, string> {
    return {
      ...this.headers,
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {})
    };
  }
}

interface RawChunk {
  choices?: {
    delta?: {
      content?: string;
      reasoning_content?: string;
      reasoning?: string;
      tool_calls?: {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: Usage;
}

export function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = (baseUrl || '').trim().replace(/\/+$/, '');
  if (!trimmed) {
    return 'http://127.0.0.1:8000';
  }
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  // 用户常把整条兼容端点贴进来(http://host:8000/v1),而请求路径自己就带 /v1,
  // 不去掉会变成 /v1/v1/models 直接 404。
  return withScheme.replace(/\/v1$/i, '');
}

function parseJson<T>(body: string, target: string): T {
  try {
    return JSON.parse(body) as T;
  } catch {
    const preview = body.replace(/\s+/g, ' ').trim().slice(0, 200);
    throw new SplashError(
      `splash 的 ${target} 返回的不是 JSON(是不是反代/报错页?)`,
      preview || '(空响应体)'
    );
  }
}

/** 服务端不认 `stream_options` 时会直接 400,这时值得去掉它重试一次。 */
function rejectsStreamOptions(error: unknown): boolean {
  if (!(error instanceof SplashError) || error.statusCode !== 400) {
    return false;
  }
  return /stream_options|include_usage/i.test(`${error.detail ?? ''} ${error.message}`);
}

/** 连接被拒时请求根本没发出去,等一下重试是安全的(也只重试这一次)。 */
const RETRY_DELAY_MS = 400;
/** 连接重试 + stream_options 降级重试,最多三次请求。 */
const MAX_STREAM_ATTEMPTS = 3;

function isTransientConnection(error: unknown): boolean {
  return error instanceof SplashError && error.retryable;
}

/** 这里不能 unref:等待重试时若没有别的句柄,进程会直接退出(node 脚本里会静默中断)。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
