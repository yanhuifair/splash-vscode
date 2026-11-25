import type { ChatContentPart, ChatFilePart, ChatMessage, ChatRole, ChatToolCall, ChatToolSpec } from './client';

export interface ProviderMessageLike {
  readonly role: number;
  readonly content: readonly unknown[];
  readonly name?: string | undefined;
}

export interface ToolLike {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: object;
}

const ROLE_USER = 1;
const ROLE_SYSTEM = 3;

/** 拿不到图片尺寸时,按 OpenAI 高细节档的口径保守估算单张图片的输入 token。 */
const IMAGE_TOKEN_ESTIMATE = 850;
/** splash 会把每页 PDF 渲染成一张图片 + 文本,按页估算比按字节估算贴近实际。 */
const MAX_PDF_PAGES_ESTIMATE = 64;
const PDF_DATA_URL_PREFIX = 'data:application/pdf;base64,';

const IMAGE_PLACEHOLDER = '\n[图片]\n';

interface ParsedFile {
  part: ChatFilePart;
  bytes: number;
  pages: number;
}

interface ToolResultPayload {
  callId: string;
  text: string;
  images: ChatContentPart[];
  files: ParsedFile[];
}

interface ParsedPart {
  text?: string;
  image?: ChatContentPart;
  file?: ParsedFile;
  toolCall?: ChatToolCall;
  toolResult?: ToolResultPayload;
}

/**
 * `LanguageModelChatRequestMessage` → OpenAI 消息。
 *
 * VS Code 的 `LanguageModelDataPart` 字段叫 `mimeType`(不是 `mime`),认错字段会把
 * 图片二进制当成文本塞进提示词;不认识的二进制也不再解码,统一留占位。
 */
export function toChatMessages(messages: readonly ProviderMessageLike[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  for (const message of messages) {
    const role = toRole(message.role);
    const parts = readParts(message.content);

    if (role === 'assistant') {
      const texts = parts.flatMap((part) => (part.text ? [part.text] : []));
      const toolCalls = parts.flatMap((part) => (part.toolCall ? [part.toolCall] : []));
      if (!texts.length && !toolCalls.length) {
        continue;
      }
      result.push({
        role,
        content: texts.length ? texts.join('') : null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {})
      });
      continue;
    }

    const texts: string[] = [];
    const images: ChatContentPart[] = [];
    const files: ChatContentPart[] = [];
    for (const part of parts) {
      if (part.text) {
        texts.push(part.text);
      }
      if (part.image) {
        images.push(part.image);
      }
      if (part.file) {
        files.push(part.file.part);
      }
      const toolResult = part.toolResult;
      if (!toolResult) {
        continue;
      }
      result.push({ role: 'tool', tool_call_id: toolResult.callId, content: toolResult.text });
      // OpenAI 的 role:tool 只收字符串,工具返回的图片/PDF 塞不进去,
      // 紧跟一条 user 消息带上,否则视觉/文档工具的结果会被静默丢掉。
      if (toolResult.images.length || toolResult.files.length) {
        const media = [...toolResult.images, ...toolResult.files.map((file) => file.part)];
        result.push({
          role: 'user',
          content: [{ type: 'text', text: '以下是上一条工具结果里的附件:' } as ChatContentPart, ...media]
        });
      }
    }

    if (images.length || files.length) {
      result.push({
        role,
        content: [...texts.map((text) => ({ type: 'text', text }) as ChatContentPart), ...images, ...files]
      });
      continue;
    }
    if (texts.length) {
      result.push({ role, content: texts.join('') });
    }
  }
  return result;
}

export function toToolSpecs(tools: readonly ToolLike[] | undefined): ChatToolSpec[] | undefined {
  if (!tools?.length) {
    return undefined;
  }
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.inputSchema ?? { type: 'object', properties: {} }
    }
  }));
}

/** 把一条消息压成纯文本(日志/缓存键用);媒体只留带元信息的占位。 */
export function messageText(message: ProviderMessageLike): string {
  const parts: string[] = [];
  for (const part of readParts(message.content)) {
    if (part.text) {
      parts.push(part.text);
    }
    if (part.image) {
      parts.push(IMAGE_PLACEHOLDER);
    }
    if (part.file) {
      parts.push(`\n[PDF: ${part.file.bytes} 字节, ${part.file.pages} 页]\n`);
    }
    if (part.toolCall) {
      parts.push(`${part.toolCall.function.name}${part.toolCall.function.arguments}`);
    }
    if (part.toolResult) {
      parts.push(part.toolResult.text);
      for (let index = 0; index < part.toolResult.images.length; index += 1) {
        parts.push(IMAGE_PLACEHOLDER);
      }
      for (const file of part.toolResult.files) {
        parts.push(`\n[PDF: ${file.bytes} 字节, ${file.pages} 页]\n`);
      }
    }
  }
  return parts.join('');
}

/**
 * 按 part 类型估算一条消息的 token:工具结果、工具调用参数、图片和 PDF 都算进去。
 * 只统计 `value` 字段时,4000 字的工具结果会被算成 0 token。
 */
export function estimateMessageTokens(message: ProviderMessageLike): number {
  let tokens = 0;
  for (const part of readParts(message.content)) {
    if (part.text) {
      tokens += estimateTextTokens(part.text);
    }
    if (part.image) {
      tokens += IMAGE_TOKEN_ESTIMATE;
    }
    if (part.file) {
      tokens += estimatePdfTokens(part.file.pages);
    }
    if (part.toolCall) {
      tokens += estimateTextTokens(`${part.toolCall.function.name}${part.toolCall.function.arguments}`);
    }
    if (part.toolResult) {
      tokens += estimateTextTokens(part.toolResult.text);
      tokens += part.toolResult.images.length * IMAGE_TOKEN_ESTIMATE;
      for (const file of part.toolResult.files) {
        tokens += estimatePdfTokens(file.pages);
      }
    }
  }
  return tokens;
}

/** 一条消息里有多少张图片(直接附图 + 工具结果附图)。/tokenize 看不见这些,要单独估算。 */
export function messageImageCount(message: ProviderMessageLike): number {
  let count = 0;
  for (const part of readParts(message.content)) {
    if (part.image) {
      count += 1;
    }
    if (part.toolResult) {
      count += part.toolResult.images.length;
    }
  }
  return count;
}

/** 一条消息里有多少个 PDF;/tokenize 只数文本,PDF 的开销在渲染后的每页图片上。 */
export function messagePdfCount(message: ProviderMessageLike): number {
  let count = 0;
  for (const part of readParts(message.content)) {
    if (part.file) {
      count += 1;
    }
    if (part.toolResult) {
      count += part.toolResult.files.length;
    }
  }
  return count;
}

function estimatePdfTokens(pages: number): number {
  return Math.max(1, Math.min(MAX_PDF_PAGES_ESTIMATE, pages)) * IMAGE_TOKEN_ESTIMATE;
}

/**
 * 字符估算:CJK 每个字约 0.75 token,其余按 4 字符/token。
 * 一律用 `length / 4` 会低估中文 5 倍以上,是上下文超限的主因。
 */
export function estimateTextTokens(text: string): number {
  if (!text) {
    return 0;
  }
  let wide = 0;
  let narrow = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (isWideChar(code)) {
      wide += 1;
    } else {
      narrow += 1;
    }
  }
  return Math.ceil(wide * 0.75 + narrow / 4);
}

function isWideChar(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xa960 && code <= 0xa97f) ||
    (code >= 0xac00 && code <= 0xd7ff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

function readParts(content: readonly unknown[] | undefined): ParsedPart[] {
  const parts: ParsedPart[] = [];
  for (const part of content ?? []) {
    const parsed = readPart(part);
    if (parsed) {
      parts.push(parsed);
    }
  }
  return parts;
}

function readPart(part: unknown): ParsedPart | undefined {
  if (typeof part === 'string') {
    return part ? { text: part } : undefined;
  }
  if (!part || typeof part !== 'object') {
    return undefined;
  }
  const candidate = part as Record<string, unknown>;

  if (typeof candidate.callId === 'string' && Array.isArray(candidate.content)) {
    return { toolResult: readToolResult(candidate.callId, candidate.content) };
  }

  if (typeof candidate.callId === 'string' && typeof candidate.name === 'string') {
    return {
      toolCall: {
        id: candidate.callId,
        type: 'function',
        function: { name: candidate.name, arguments: stringifyInput(candidate.input) }
      }
    };
  }

  if (candidate.data instanceof Uint8Array) {
    return readDataPart(candidate, candidate.data);
  }

  if (typeof candidate.value === 'string') {
    return candidate.value ? { text: candidate.value } : undefined;
  }

  if (candidate.value !== undefined) {
    const serialized = safeStringify(candidate.value);
    return serialized ? { text: serialized } : undefined;
  }

  return undefined;
}

function readDataPart(candidate: Record<string, unknown>, data: Uint8Array): ParsedPart | undefined {
  const mime = partMime(candidate);
  const bytes = Buffer.from(data);
  if (isImageMime(mime)) {
    return {
      image: {
        type: 'image_url',
        image_url: { url: `data:${mime || 'image/png'};base64,${bytes.toString('base64')}` }
      }
    };
  }
  if (isPdfMime(mime)) {
    return {
      file: {
        part: { type: 'file', file: { file_data: `${PDF_DATA_URL_PREFIX}${bytes.toString('base64')}` } },
        bytes: bytes.length,
        pages: countPdfPages(bytes)
      }
    };
  }
  if (isTextMime(mime)) {
    const inline = bytes.toString('utf8');
    return inline ? { text: inline } : undefined;
  }
  // 未知二进制:不解码,免得把 PNG/PDF 的字节当成提示词塞进去。
  return { text: `[${mime || '二进制'} 数据, ${bytes.length} 字节]` };
}

function readToolResult(callId: string, content: readonly unknown[]): ToolResultPayload {
  const texts: string[] = [];
  const images: ChatContentPart[] = [];
  const files: ParsedFile[] = [];
  for (const item of content) {
    const parsed = readPart(item);
    if (!parsed) {
      continue;
    }
    if (parsed.text) {
      texts.push(parsed.text);
    }
    if (parsed.image) {
      images.push(parsed.image);
    }
    if (parsed.file) {
      files.push(parsed.file);
    }
    if (parsed.toolResult) {
      texts.push(parsed.toolResult.text);
      images.push(...parsed.toolResult.images);
      files.push(...parsed.toolResult.files);
    }
  }
  return { callId, text: texts.join('\n') || '(空结果)', images, files };
}

/** VS Code 用 `mimeType`;`mime` 只作为兼容旧形状的兜底。 */
function partMime(part: Record<string, unknown>): string {
  for (const key of ['mimeType', 'mime']) {
    const value = part[key];
    if (typeof value === 'string' && value) {
      return value;
    }
  }
  return '';
}

function isImageMime(mime: string): boolean {
  return /^image\//i.test(mime);
}

function isPdfMime(mime: string): boolean {
  return /^application\/(x-)?pdf$/i.test(mime);
}

/** 大多数 PDF 没压缩对象流时可直接数 /Type /Page;压缩或数不到就按 1 页保守估。 */
function countPdfPages(bytes: Buffer): number {
  const text = bytes.toString('latin1');
  const pages = (text.match(/\/Type\s*\/Page\b/g) ?? []).length;
  return Math.max(1, Math.min(MAX_PDF_PAGES_ESTIMATE, pages));
}

function isTextMime(mime: string): boolean {
  return !mime || /^text\//i.test(mime) || /^application\/(json|xml|x-ndjson)$/i.test(mime);
}

function stringifyInput(input: unknown): string {
  if (input === undefined || input === null) {
    return '{}';
  }
  if (typeof input === 'string') {
    return input;
  }
  const serialized = safeStringify(input);
  return serialized || '{}';
}

function toRole(role: number): ChatRole {
  if (role === ROLE_SYSTEM) {
    return 'system';
  }
  return role === ROLE_USER ? 'user' : 'assistant';
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}
