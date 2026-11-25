import * as vscode from 'vscode';
import {
  SplashClient,
  SplashError,
  SplashTimeoutError,
  type ChatRequest,
  type SplashModelDescription,
  type SplashTimeouts,
  type Usage
} from './client';
import {
  estimateMessageTokens,
  estimateTextTokens,
  messageImageCount,
  messagePdfCount,
  messageText,
  toChatMessages,
  toToolSpecs,
  type ProviderMessageLike
} from './openai';
import { resolveToolCalls, type OfferedTool, type RawToolCall } from './toolCalls';
import { deriveTimeouts, type SplashStatus } from './timeouts';
import { displayLabel, shortContext } from './naming';
import { readThinkingLevels, resolveThinkingLevel, type ThinkingLevelValue } from './thinking';
import {
  groupKey,
  hashText,
  readProviderConfig,
  readStringRecord,
  type ProviderGroupConfig
} from './providerConfig';

export interface SplashSettings {
  baseUrl: string;
  apiKey: string;
  headers: Record<string, string>;
  allowedModels: string[];
  modelFilter: string;
  maxOutputTokens: number;
  temperature: number | null;
  reasoningEffort: 'server' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  thinkingLevels: Record<string, ThinkingLevelValue>;
  reasoningMode: ReasoningMode;
  serverTokenizer: boolean;
  enableTools: boolean;
  maxToolsPerRequest: number;
  connectTimeoutMs: number;
  idleTimeoutMs: number;
  requestTimeoutMs: number;
}

interface SplashModelInfo extends vscode.LanguageModelChatInformation {
  readonly contextLength: number;
  readonly efforts?: readonly string[];
  /** 这个模型属于哪个「管理模型」配置组;请求必须回到同一组地址/密钥。 */
  readonly groupKey: string;
}

/** 每个配置组独立的缓存与状态,避免 A 组的服务地址/token 数跑到 B 组。 */
interface GroupState {
  models: SplashModelInfo[];
  lastError?: string;
  listedAt: number;
  nextRetryAt: number;
  stale: boolean;
  statusCache?: SplashStatus;
  statusAt: number;
  lastTimeoutNote: string;
  lastWarn: { message: string; at: number };
  tokenCache: Map<string, number>;
  tokenizerDownUntil: number;
  thinkingNotes: Map<string, string>;
}

function newGroupState(): GroupState {
  return {
    models: [],
    listedAt: 0,
    nextRetryAt: 0,
    stale: false,
    statusAt: 0,
    lastTimeoutNote: '',
    lastWarn: { message: '', at: 0 },
    tokenCache: new Map<string, number>(),
    tokenizerDownUntil: 0,
    thinkingNotes: new Map<string, string>()
  };
}

const DEFAULT_CONTEXT = 8192;

/**
 * VS Code 会为标题等内部小任务发起 max_tokens 只有几十的请求,
 * 这种请求的回复同样可能被截断,把提示写进去会被当成会话标题。
 */
const NOTICE_MIN_MAX_TOKENS = 256;

export type ReasoningMode = 'off' | 'stream' | 'final';

/** 一次请求的对外状态:状态栏靠它显示「等待响应 / 生成中 / 失败」。 */
export type RequestState = 'idle' | 'waiting' | 'streaming' | 'failed';

type ThinkingPartCtor = new (value: string, id?: string) => vscode.LanguageModelResponsePart;

let thinkingPartCtor: ThinkingPartCtor | undefined;
let thinkingPartProbed = false;

function probeThinkingPart(log: (message: string) => void): ThinkingPartCtor | undefined {
  if (thinkingPartProbed) {
    return thinkingPartCtor;
  }
  thinkingPartProbed = true;
  try {
    const candidate = (vscode as unknown as Record<string, unknown>).LanguageModelThinkingPart;
    if (typeof candidate === 'function') {
      thinkingPartCtor = candidate as ThinkingPartCtor;
    }
  } catch (error) {
    log(`当前 VS Code 未暴露 LanguageModelThinkingPart,思考内容改用引用块显示: ${errorMessage(error)}`);
  }
  return thinkingPartCtor;
}

export class SplashModelProvider implements vscode.LanguageModelChatProvider<SplashModelInfo> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.emitter.event;
  private readonly requestEmitter = new vscode.EventEmitter<RequestState>();
  /** 状态栏据此显示「等待响应 / 生成中」,本地模型首字慢的时候尤其需要。 */
  readonly onDidChangeRequestState = this.requestEmitter.event;

  private readonly states = new Map<string, GroupState>();
  private readonly groupConfigs = new Map<string, ProviderGroupConfig>();
  /** 空字符串代表没有配置组的旧用法:只读 splash.* 全局设置。 */
  private activeKey = '';
  private lastUsedModel: SplashModelInfo | undefined;
  /** 存在系统钥匙串里的 apiKey,优先于设置里的明文值;配置组里的 apiKey 又优先于它。 */
  private secretApiKey = '';

  constructor(private readonly log: (message: string) => void) {}

  private state(key = this.activeKey): GroupState {
    let state = this.states.get(key);
    if (!state) {
      state = newGroupState();
      this.states.set(key, state);
    }
    return state;
  }

  private rememberGroup(config: ProviderGroupConfig | undefined): string {
    const key = groupKey(config);
    if (key) {
      this.groupConfigs.set(key, config ?? {});
    }
    this.activeKey = key;
    return key;
  }

  get error(): string | undefined {
    return this.state().lastError;
  }

  /** 现在展示的是上一次成功的结果(服务暂时连不上)。 */
  get isStale(): boolean {
    return this.state().stale;
  }

  get currentModels(): readonly SplashModelInfo[] {
    return this.state().models;
  }

  /** 最近一次真正用来生成回复的模型;状态栏显示它比显示 models[0] 更贴近实际。 */
  get lastModel(): SplashModelInfo | undefined {
    return this.lastUsedModel;
  }

  setApiKey(key: string): void {
    this.secretApiKey = key.trim();
  }

  /** 给「Splash: 诊断模型」命令用:只输出配置摘要,不泄露密钥。 */
  diagnosticLines(): string[] {
    const state = this.state();
    const settings = this.currentSettings();
    const overrides = Object.entries(settings.thinkingLevels)
      .map(([id, level]) => `${id}=${typeof level === 'boolean' ? String(level) : level}`)
      .join(', ');
    const lines = [
      `配置来源: ${this.activeKey ? `管理模型配置组 ${this.activeKey.slice(0, 8)}` : 'workspace splash.*'}`,
      `服务地址: ${settings.baseUrl}`,
      `模型白名单: ${settings.allowedModels.length ? settings.allowedModels.join(', ') : '(全部)'}`,
      `自定义 headers: ${Object.keys(settings.headers).join(', ') || '(无)'}`,
      `API Key: ${settings.apiKey ? '已配置' : '未配置'}`,
      `全局思考强度: ${settings.reasoningEffort}`,
      `按模型覆盖: ${overrides || '(无)'}`,
      `已缓存模型: ${state.models.length}${state.lastError ? ` (最近错误: ${state.lastError})` : ''}`
    ];
    for (const model of state.models) {
      lines.push(
        `  - ${model.id} | efforts=${(model.efforts ?? []).join('/') || '(未声明)'} | ${state.thinkingNotes.get(model.id) ?? '本次会话尚未发起请求'}`
      );
    }
    return lines;
  }

  /** 合并了配置组、钥匙串与 splash.* 全局设置,命令与请求都走这里。 */
  currentSettings(): SplashSettings {
    return this.settingsFor(this.activeKey);
  }

  /** 同一条警告 60 秒内只弹一次(模型选择器会被频繁轮询)。 */
  private warnOnce(message: string, state: GroupState): void {
    if (message === state.lastWarn.message && Date.now() - state.lastWarn.at < 60_000) {
      return;
    }
    state.lastWarn = { message, at: Date.now() };
    void vscode.window.showWarningMessage(`Splash: ${message}`);
  }

  async refresh(silent: boolean, config?: ProviderGroupConfig): Promise<SplashModelInfo[]> {
    const key = config === undefined ? this.activeKey : this.rememberGroup(config);
    const state = this.state(key);
    const settings = this.settingsFor(key);
    try {
      const descriptions = await this.client(settings, await this.currentTimeouts(settings, state)).listModels();
      state.models = this.toModelInfos(descriptions, settings, key);
      state.lastError = undefined;
      state.stale = false;
      state.nextRetryAt = 0;
      state.listedAt = Date.now();
      const configured = settings.allowedModels;
      if (configured.length) {
        const returned = new Set(descriptions.map((model) => model.id));
        const missing = configured.filter((id) => !returned.has(id));
        if (missing.length) {
          this.log(`配置组里这些模型服务未返回: ${missing.join(', ')}`);
        }
      }
      this.log(`已加载 ${state.models.length} 个模型: ${state.models.map((model) => model.id).join(', ') || '(无)'}`);
    } catch (error) {
      state.lastError = errorMessage(error);
      // 一次网络抖动不该把模型选择器清空:保留上次结果,只标记为过期。
      state.stale = state.models.length > 0;
      if (!state.stale) {
        state.models = [];
      }
      state.nextRetryAt = Date.now() + RETRY_BACKOFF_MS;
      this.log(
        `读取模型列表失败: ${state.lastError}${state.stale ? `(保留上次 ${state.models.length} 个模型)` : ''}`
      );
      if (!silent) {
        void vscode.window.showWarningMessage(`Splash: ${state.lastError}`, '打开设置').then((choice) => {
          if (choice === '打开设置') {
            void vscode.commands.executeCommand('workbench.action.openSettings', '@splash');
          }
        });
      }
    }
    this.emitter.fire();
    return state.models;
  }

  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    token: vscode.CancellationToken
  ): Promise<SplashModelInfo[]> {
    const config = readProviderConfig(options);
    const key = this.rememberGroup(config);
    const state = this.state(key);
    const isFresh = Date.now() - state.listedAt < 15_000 && (state.models.length > 0 || Boolean(state.lastError));
    const cooling = Date.now() < state.nextRetryAt;
    if (!isFresh && !cooling && !token.isCancellationRequested) {
      return this.refresh(options.silent, config);
    }
    if (state.lastError && !options.silent) {
      // 模型选择器每打开一次就会问一遍,同一条错误没必要反复弹。
      this.warnOnce(state.lastError, state);
    }
    return state.models;
  }

  async provideLanguageModelChatResponse(
    model: SplashModelInfo,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const key = model.groupKey ?? '';
    this.activeKey = key;
    const state = this.state(key);
    const settings = this.settingsFor(key);
    const timeouts = await this.currentTimeouts(settings, state);
    const request = this.buildRequest(model, messages, options, settings, state);
    const maxTokens = request.max_tokens ?? settings.maxOutputTokens;
    this.log(
      `→ ${model.id} @ ${settings.baseUrl}${key ? ` (配置组 ${key.slice(0, 8)})` : ''} | ${request.messages.length} 条消息 | tools=${request.tools?.length ?? 0}/${options.tools?.length ?? 0} | max_tokens=${request.max_tokens}`
    );

    const controller = new AbortController();
    const cancellation = token.onCancellationRequested(() => controller.abort());
    const signal = controller.signal;

    this.lastUsedModel = model;
    this.requestEmitter.fire('waiting');
    let sawFirstChunk = false;
    let failed = false;

    const toolCalls = new Map<number, RawToolCall>();
    let textLength = 0;
    let usage: Usage | undefined;
    let finishReason: string | undefined;
    const reasoning = new ReasoningSink(progress, settings.reasoningMode, probeThinkingPart(this.log), this.log);

    try {
      await this.client(settings, timeouts).streamChat(
        request,
        (chunk) => {
          if (!sawFirstChunk) {
            sawFirstChunk = true;
            this.requestEmitter.fire('streaming');
          }
          if (chunk.text) {
            textLength += chunk.text.length;
            reasoning.beforeText();
            progress.report(new vscode.LanguageModelTextPart(chunk.text));
          }
          if (chunk.reasoning) {
            reasoning.push(chunk.reasoning);
          }
          for (const call of chunk.toolCalls ?? []) {
            const entry = toolCalls.get(call.index) ?? { args: '' };
            entry.id = call.id ?? entry.id;
            entry.name = call.name ?? entry.name;
            entry.args += call.arguments ?? '';
            toolCalls.set(call.index, entry);
          }
          if (chunk.usage) {
            usage = chunk.usage;
          }
          if (chunk.finishReason) {
            finishReason = chunk.finishReason;
          }
        },
        signal
      );
    } catch (error) {
      const cancelled = (error as Error)?.name === 'AbortError' || token.isCancellationRequested;
      failed = !cancelled;
      // 已经流出来的思考内容不该因为后半段失败就凭空消失;但用户点了停止就别再往
      // 已取消的回复里写东西了(会抛出另一个 Canceled 把真正的取消原因盖掉)。
      if (!cancelled) {
        reasoning.finish();
      }
      if (error instanceof SplashTimeoutError) {
        this.log(`请求超时: ${error.message}${error.detail ? ` (${error.detail})` : ''}`);
        throw new Error(await this.describeTimeout(error, settings));
      }
      if (cancelled) {
        throw new vscode.CancellationError();
      }
      this.log(`请求失败: ${errorMessage(error)}`);
      throw error instanceof SplashError ? new Error(`${error.message}(详细日志:Output → Splash)`) : error;
    } finally {
      cancellation.dispose();
      this.requestEmitter.fire(failed ? 'failed' : 'idle');
    }

    reasoning.finish();

    const resolved = resolveToolCalls([...toolCalls.values()], offeredTools(options.tools, settings.maxToolsPerRequest));
    if (finishReason === 'length') {
      this.log(`  ! 输出在 ${maxTokens} tokens 处被截断(splash.maxOutputTokens)`);
      if (maxTokens >= NOTICE_MIN_MAX_TOKENS) {
        progress.report(
          new vscode.LanguageModelTextPart(
            `\n\n_回复在 ${maxTokens} tokens 处被截断,可调大 \`splash.maxOutputTokens\`。_\n`
          )
        );
      }
    }
    if (resolved.skipped.length) {
      for (const skip of resolved.skipped) {
        this.log(`  ✗ 跳过工具调用 ${skip.name}: ${skip.reason} | 原始参数 ${preview(skip.args)}`);
      }
      if (maxTokens >= NOTICE_MIN_MAX_TOKENS) {
        progress.report(
          new vscode.LanguageModelTextPart(
            `\n\n_Splash: 已跳过 ${resolved.skipped.length} 个无效工具调用(${resolved.skipped.map((skip) => `${skip.name}: ${skip.reason}`).join(';')})。_\n`
          )
        );
      }
    }
    for (const call of resolved.calls) {
      progress.report(new vscode.LanguageModelToolCallPart(call.callId, call.name, call.input));
      this.log(`  ↳ 工具 ${call.name}(${preview(stableStringify(call.input))})${call.repaired ? ' [参数被截断,已修复]' : ''}`);
    }

    // 完全空白的气泡看起来像扩展坏了,给一句明确交代。
    if (!textLength && !reasoning.length && !resolved.calls.length && finishReason !== 'length' && maxTokens >= NOTICE_MIN_MAX_TOKENS) {
      progress.report(
        new vscode.LanguageModelTextPart(
          `\n\n_模型没有返回内容(finish=${finishReason ?? '未知'})。可重试一次,或打开 Output → Splash 看这次请求的原始返回。_\n`
        )
      );
    }

    this.log(
      `← ${model.id} | 文本 ${textLength} 字符 | 思考 ${reasoning.length} 字符 | 工具调用 ${resolved.calls.length} 个${resolved.skipped.length ? ` (跳过 ${resolved.skipped.length} 个)` : ''} | finish=${finishReason ?? '未知'} | ${usageText(usage)}`
    );
  }

  async provideTokenCount(
    model: SplashModelInfo,
    text: string | vscode.LanguageModelChatRequestMessage,
    token: vscode.CancellationToken
  ): Promise<number> {
    const message = typeof text === 'string' ? undefined : (text as ProviderMessageLike);
    const value = typeof text === 'string' ? text : messageText(text as ProviderMessageLike);
    const key = `${model.groupKey ?? ''}\u0000${model.id}\u0000${hashText(value)}`;
    const state = this.state(model.groupKey ?? '');
    this.activeKey = model.groupKey ?? '';
    const cached = state.tokenCache.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const imageCount = message ? messageImageCount(message) : 0;
    const pdfCount = message ? messagePdfCount(message) : 0;
    const settings = this.settingsFor(this.activeKey);
    let count: number | undefined;
    // 含图片/PDF 的消息不能问 /tokenize:它只数文本,媒体的真实开销会被算成 0。
    if (settings.serverTokenizer && !imageCount && !pdfCount && Date.now() >= state.tokenizerDownUntil) {
      const link = tokenSignal(token);
      try {
        // /tokenize 是很轻的本地请求,固定用小超时,避免拖住聊天里的上下文计算。
        const fast = new SplashClient(settings.baseUrl, settings.apiKey || undefined, {
          connectMs: 8_000,
          idleMs: 15_000,
          totalMs: 20_000
        }, settings.headers);
        count = await fast.countTokens(value, link.signal);
      } catch (error) {
        // 服务在加载权重/被占用时,这条路径会被 VS Code 对每条消息反复调用,
        // 没有冷却就会把整个上下文计算拖死。
        state.tokenizerDownUntil = Date.now() + TOKENIZER_BACKOFF_MS;
        this.log(`token 统计失败,${Math.round(TOKENIZER_BACKOFF_MS / 1000)}s 内改用估算: ${errorMessage(error)}`);
      } finally {
        link.dispose();
      }
    }

    // 媒体没法 /tokenize,按图片张数 / PDF 页数估算。
    const result = count ?? (message ? estimateMessageTokens(message) : estimateTextTokens(value));
    const final = Math.max(value ? 1 : 0, result);
    if (state.tokenCache.size > TOKEN_CACHE_LIMIT) {
      const oldest = state.tokenCache.keys().next().value;
      if (oldest !== undefined) {
        state.tokenCache.delete(oldest);
      }
    }
    state.tokenCache.set(key, final);
    return final;
  }

  private buildRequest(
    model: SplashModelInfo,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    settings: SplashSettings,
    state: GroupState
  ): ChatRequest {
    const modelOptions = (options.modelOptions ?? {}) as Record<string, unknown>;
    const offered = settings.enableTools ? toToolSpecs(options.tools) : undefined;
    // VS Code 应该已经按 capabilities.toolCalling 的限制裁剪过,这里再截一次:
    // 老版本或第三方调用方忽略该字段时,本地模型也不会被上百个工具 schema 压垮。
    const tools = offered && settings.maxToolsPerRequest > 0 ? offered.slice(0, settings.maxToolsPerRequest) : offered;
    const maxTokens = positiveNumber(modelOptions.max_tokens ?? modelOptions.maxOutputTokens) ?? settings.maxOutputTokens;
    const temperature = numberOrNull(modelOptions.temperature) ?? settings.temperature;
    const topP = numberOrNull(modelOptions.top_p);
    const thinking = resolveThinkingLevel(
      model.id,
      modelOptions,
      settings.thinkingLevels,
      settings.reasoningEffort,
      model.efforts ?? []
    );
    state.thinkingNotes.set(model.id, thinking.note);
    if (!thinking.supported) {
      this.warnOnce(thinking.note, state);
    }

    const request: ChatRequest = {
      model: model.id,
      messages: toChatMessages(messages as readonly ProviderMessageLike[]),
      max_tokens: Math.min(maxTokens, model.maxOutputTokens),
      stream: true
    };
    if (tools?.length) {
      request.tools = tools;
      request.tool_choice = options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto';
    }
    if (temperature !== null) {
      request.temperature = temperature;
    }
    if (topP !== null) {
      request.top_p = topP;
    }
    if (thinking.level) {
      request.reasoning_effort = thinking.level;
    }
    return request;
  }

  private toModelInfos(
    descriptions: readonly SplashModelDescription[],
    settings: SplashSettings,
    groupKey: string
  ): SplashModelInfo[] {
    const filter = settings.modelFilter
      .split(',')
      .map((term) => term.trim().toLowerCase())
      .filter(Boolean);
    const allowed = settings.allowedModels;
    const maxOutput = Math.max(1, settings.maxOutputTokens);

    return descriptions
      .filter((model) => !allowed.length || allowed.includes(model.id))
      .filter((model) => !filter.length || filter.some((term) => model.id.toLowerCase().includes(term)))
      .map((model) => {
        const context = model.context_length ?? model.max_model_len ?? DEFAULT_CONTEXT;
        const output = Math.max(1, Math.min(maxOutput, Math.floor(context / 2)));
        const label = displayLabel(model.id);
        const efforts = model.reasoning?.efforts ?? [];
        return {
          id: model.id,
          name: label.name,
          family: label.family,
          version: '1',
          // 选择器里名字保持一致,靠 detail 区分量化档与上下文(UD-Q4_K_M · 32k)。
          detail: [label.badge, shortContext(context)].filter(Boolean).join(' · '),
          tooltip: describeModel(model, context, efforts),
          // 输入 + 输出不能超过模型上下文,否则 VS Code 会按虚高的预算放行,服务端再 400。
          maxInputTokens: Math.max(1, context - output),
          maxOutputTokens: output,
          contextLength: context,
          efforts,
          groupKey,
          capabilities: {
            imageInput: model.vision === true || (model.input_modalities ?? []).includes('image'),
            toolCalling: settings.enableTools
              ? settings.maxToolsPerRequest > 0
                ? settings.maxToolsPerRequest
                : true
              : false
          }
        };
      });
  }

  private client(settings: SplashSettings, timeouts: SplashTimeouts): SplashClient {
    return new SplashClient(settings.baseUrl, settings.apiKey || undefined, timeouts, settings.headers);
  }

  /**
   * 优先级:配置组的字段 > 系统钥匙串 > splash.* 明文设置。
   * 配置组里的 apiKey 由 VS Code 以 secret 字段安全存储,运行时按组下发。
   */
  private settingsFor(key: string): SplashSettings {
    const settings = readSettings();
    if (this.secretApiKey) {
      settings.apiKey = this.secretApiKey;
    }
    const group = key ? this.groupConfigs.get(key) : undefined;
    if (!group) {
      return settings;
    }
    if (typeof group.url === 'string' && group.url.trim()) {
      settings.baseUrl = group.url.trim();
    }
    if (typeof group.apiKey === 'string' && group.apiKey.trim()) {
      settings.apiKey = group.apiKey.trim();
    }
    if (group.headers) {
      settings.headers = { ...settings.headers, ...readStringRecord(group.headers) };
    }
    if (group.models?.length) {
      settings.allowedModels = group.models.filter((id) => typeof id === 'string' && id.length > 0);
    }
    return settings;
  }

  /** 默认从服务状态推导超时;设置里给了具体数字才覆盖。状态按配置组隔离。 */
  async currentTimeouts(settings: SplashSettings, state = this.state()): Promise<SplashTimeouts> {
    const wantsStatus = settings.connectTimeoutMs === 0 || settings.idleTimeoutMs === 0;
    const stale = Date.now() - state.statusAt > 60_000;
    if (wantsStatus && stale) {
      if (state.statusCache) {
        // 已经有上次结果就别为了一次刷新把这条消息卡住:后台更新,这次用旧值。
        void this.statusProbe(settings, state);
      } else {
        await this.statusProbe(settings, state);
      }
    }
    const derived = deriveTimeouts(settings, state.statusCache);
    const note = `超时 connect=${derived.connectMs} idle=${derived.idleMs} total=${derived.totalMs}`;
    if (note !== state.lastTimeoutNote) {
      state.lastTimeoutNote = note;
      this.log(`${note}${derived.notes.length ? ` | ${derived.notes.join(' | ')}` : ''}`);
    }
    return { connectMs: derived.connectMs, idleMs: derived.idleMs, totalMs: derived.totalMs };
  }

  private async statusProbe(settings: SplashSettings, state: GroupState): Promise<SplashStatus | undefined> {
    // 本地 /status 正常都是毫秒级;等不到就直接用兜底值,不值得为它拖慢首字。
    const quick = new SplashClient(settings.baseUrl, settings.apiKey || undefined, { connectMs: 1_500, idleMs: 1_500, totalMs: 3_000 }, settings.headers);
    try {
      state.statusCache = (await quick.status()) as SplashStatus;
      state.statusAt = Date.now();
    } catch (error) {
      state.statusAt = Date.now();
      this.log(`读取 /status 失败,超时改用${state.statusCache ? '上次结果' : '内置默认'}: ${errorMessage(error)}`);
    }
    return state.statusCache;
  }

  /**
   * 超时之后顺手探一下 /health:同样是"没响应",服务在线(慢/在加载模型)、
   * 在线但拒绝请求(401/500)、根本没启动,是三件完全不同的事。
   */
  private async describeTimeout(error: SplashTimeoutError, settings: SplashSettings): Promise<string> {
    const probe = new SplashClient(settings.baseUrl, settings.apiKey || undefined, { connectMs: 2_500, idleMs: 2_500, totalMs: 5_000 }, settings.headers);
    let verdict: 'online' | 'busy' | 'offline' | 'rejected' = 'offline';
    let status: number | undefined;
    try {
      verdict = (await probe.health()) ? 'online' : 'busy';
    } catch (probeError) {
      if (probeError instanceof SplashTimeoutError) {
        verdict = 'busy';
      } else if (probeError instanceof SplashError && probeError.statusCode) {
        // 服务明明在,只是拒绝了这个请求:说「没启动」会把人带偏。
        verdict = 'rejected';
        status = probeError.statusCode;
      } else {
        verdict = 'offline';
      }
    }
    const suffix =
      verdict === 'online'
        ? `${settings.baseUrl} 在线(/health 正常),只是这一次请求太慢:可加大 splash.connectTimeoutMs / splash.idleTimeoutMs,或减少上下文与工具数量、把 splash.reasoningEffort 调成 low。`
        : verdict === 'busy'
          ? `${settings.baseUrl} 端口能连上,但连 /health 都没在 2500 ms 内应答,服务大概率正在加载模型或被其他请求占用;请等它空闲后再试,或加大 splash.connectTimeoutMs。`
          : verdict === 'rejected'
            ? `${settings.baseUrl} 在线,但 /health 返回 ${status}${status === 401 || status === 403 ? ':检查 splash.apiKey 是否与 splash serve --api-key 一致。' : ',服务自己报错了,看 splash serve 的终端输出。'}`
            : `看起来 ${settings.baseUrl} 上没有可用的 splash 服务:请先运行 splash serve,或检查 splash.baseUrl。`;
    this.log(`超时探测 /health: ${verdict}${status ? ` (${status})` : ''}`);
    return `Splash: ${error.message} ${suffix}`;
  }
}

/** 模型列表失败后的重试间隔,避免选择器每次打开都打一轮请求。 */
const RETRY_BACKOFF_MS = 5_000;
/** /tokenize 失败后改用估算的冷却时间。 */
const TOKENIZER_BACKOFF_MS = 60_000;
const TOKEN_CACHE_LIMIT = 500;

export function readSettings(): SplashSettings {
  const config = vscode.workspace.getConfiguration('splash');
  return {
    baseUrl: config.get<string>('baseUrl', 'http://127.0.0.1:8000'),
    apiKey: config.get<string>('apiKey', '') ?? '',
    headers: readStringRecord(config.get('headers', {})),
    allowedModels: [],
    modelFilter: config.get<string>('modelFilter', '') ?? '',
    maxOutputTokens: config.get<number>('maxOutputTokens', 8192),
    temperature: config.get<number | null>('temperature', null),
    reasoningEffort: config.get<SplashSettings['reasoningEffort']>('reasoningEffort', 'server'),
    thinkingLevels: readThinkingLevels(config.get('thinkingLevels', {})),
    reasoningMode: config.get<SplashSettings['reasoningMode']>('reasoningMode', 'off'),
    serverTokenizer: config.get<boolean>('serverTokenizer', true),
    enableTools: config.get<boolean>('enableTools', true),
    maxToolsPerRequest: Math.max(0, config.get<number>('maxToolsPerRequest', 0)),
    connectTimeoutMs: config.get<number>('connectTimeoutMs', 0),
    idleTimeoutMs: config.get<number>('idleTimeoutMs', 0),
    requestTimeoutMs: config.get<number>('requestTimeoutMs', 0)
  };
}

function describeModel(model: SplashModelDescription, context: number, efforts: readonly string[]): string {
  const bits = [`${context} 上下文`];
  if (model.vision || (model.input_modalities ?? []).length) {
    bits.push(`输入: ${(model.input_modalities ?? (model.vision ? ['text', 'image'] : ['text'])).join('/')}`);
  }
  if (model.reasoning?.thinks) {
    bits.push(`思考: ${efforts.join('/') || 'on'}${model.reasoning.default ? ` (默认 ${model.reasoning.default})` : ''}`);
  }
  return `${model.id}\n${bits.join(' · ')}`;
}

function usageText(usage: Usage | undefined): string {
  if (!usage) {
    return 'usage 未知';
  }
  return `prompt ${usage.prompt_tokens ?? '?'} / completion ${usage.completion_tokens ?? '?'} / total ${usage.total_tokens ?? '?'}`;
}

function offeredTools(tools: readonly vscode.LanguageModelChatTool[] | undefined, limit = 0): OfferedTool[] {
  const list = limit > 0 ? (tools ?? []).slice(0, limit) : tools ?? [];
  return list.map((tool) => ({
    name: typeof tool.name === 'string' ? tool.name : ((tool as unknown as { toolName?: string }).toolName ?? ''),
    schema: tool.inputSchema
  }));
}

function preview(value: string, limit = 160): string {
  const singleLine = value.replace(/\s+/g, ' ').trim();
  return singleLine.length > limit ? `${singleLine.slice(0, limit)}…` : singleLine || '(空)';
}

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

/** 把 CancellationToken 接到 AbortSignal 上,并返回释放句柄(不 dispose 会一直挂在 token 上)。 */
function tokenSignal(token: vscode.CancellationToken): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const subscription = token.onCancellationRequested(() => controller.abort());
  return { signal: controller.signal, dispose: () => subscription.dispose() };
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && value > 0 ? value : undefined;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

class ReasoningSink {
  private pendingLine = '';
  private accumulated = '';
  private quoteOpen = false;
  private finalEmitted = false;
  private headerShown = false;

  constructor(
    private readonly progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    private readonly mode: ReasoningMode,
    private ThinkingPart: ThinkingPartCtor | undefined,
    private readonly log: (message: string) => void
  ) {}

  get length(): number {
    return this.accumulated.length;
  }

  push(text: string): void {
    this.accumulated += text;
    if (this.mode !== 'stream') {
      return;
    }
    if (this.reportThinking(text)) {
      return;
    }
    this.pendingLine += text;
    let index = this.pendingLine.indexOf('\n');
    while (index !== -1) {
      this.quote(this.pendingLine.slice(0, index));
      this.pendingLine = this.pendingLine.slice(index + 1);
      index = this.pendingLine.indexOf('\n');
    }
  }

  /**
   * 正文来了:先把累积的思考放出去。
   * `final` 模式如果等到 finish() 才输出,思考就会跑到回答后面去。
   */
  beforeText(): void {
    if (this.mode === 'stream' && !this.ThinkingPart) {
      this.closeQuote();
      return;
    }
    if (this.mode === 'final') {
      this.emitFinal();
    }
  }

  finish(): void {
    if (this.mode === 'off') {
      return;
    }
    if (this.mode === 'final') {
      // beforeText() 已经发过就不会重复,没发过(纯工具调用的回复)在这里补上。
      this.emitFinal();
      return;
    }
    if (this.ThinkingPart) {
      return;
    }
    this.closeQuote();
  }

  private emitFinal(): void {
    if (this.finalEmitted || !this.accumulated.trim()) {
      return;
    }
    this.finalEmitted = true;
    if (this.reportThinking(this.accumulated.trim())) {
      return;
    }
    this.progress.report(
      new vscode.LanguageModelTextPart(`\n**思考过程**\n${quoteLines(this.accumulated.trim())}\n\n`)
    );
  }

  private reportThinking(value: string): boolean {
    if (!this.ThinkingPart) {
      return false;
    }
    try {
      this.progress.report(new this.ThinkingPart(value));
      return true;
    } catch (error) {
      this.log(`思考块输出失败,本次改用引用块显示: ${errorMessage(error)}`);
      this.ThinkingPart = undefined;
      return false;
    }
  }

  private quote(text: string): void {
    if (!text.trim()) {
      return;
    }
    if (!this.quoteOpen) {
      this.quoteOpen = true;
      // 标题只出现一次:否则正文里每夹一段思考就多一个「思考过程」小标题。
      if (this.headerShown) {
        this.progress.report(new vscode.LanguageModelTextPart('\n'));
      } else {
        this.headerShown = true;
        this.progress.report(new vscode.LanguageModelTextPart('\n**思考过程**\n'));
      }
    }
    this.progress.report(new vscode.LanguageModelTextPart(`${quoteLines(text)}\n`));
  }

  private closeQuote(): void {
    if (this.pendingLine) {
      this.quote(this.pendingLine);
      this.pendingLine = '';
    }
    if (this.quoteOpen) {
      this.progress.report(new vscode.LanguageModelTextPart('\n'));
      this.quoteOpen = false;
    }
  }
}

function quoteLines(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}
