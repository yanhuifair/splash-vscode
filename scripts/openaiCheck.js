#!/usr/bin/env node
// 消息转换自检:图片必须变成 image_url,不能被当成文本;工具结果/图片的 token 不能被算成 0。
const { toChatMessages, estimateMessageTokens, estimateTextTokens, messagePdfCount } = require('../dist/openai.js');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n2 0 obj\n<< /Type /Page >>\nendobj\n%%EOF\n',
  'latin1'
);

const cases = [
  [
    '图片按 mimeType 识别(image_url,不混入二进制)',
    () => toChatMessages([{ role: 1, content: [{ value: '看图' }, { data: PNG, mimeType: 'image/png' }] }]),
    (out) => {
      const content = out[0]?.content;
      return (
        Array.isArray(content) &&
        content[0].type === 'text' &&
        content[1].type === 'image_url' &&
        content[1].image_url.url.startsWith('data:image/png;base64,') &&
        !JSON.stringify(out).includes('IHDR')
      );
    }
  ],
  [
    '图片按 mime 识别(兼容旧形状)',
    () => toChatMessages([{ role: 1, content: [{ data: PNG, mime: 'image/jpeg' }] }]),
    (out) => Array.isArray(out[0]?.content) && out[0].content[0].image_url.url.startsWith('data:image/jpeg;base64,')
  ],
  [
    'PDF DataPart 转成 splash 的 file part(不把原始字节塞进提示词)',
    () => toChatMessages([{ role: 1, content: [{ value: '看这份文档' }, { data: PDF, mimeType: 'application/pdf' }] }]),
    (out) => {
      const content = out[0]?.content;
      return (
        Array.isArray(content) &&
        content[0].type === 'text' &&
        content[1].type === 'file' &&
        content[1].file.file_data.startsWith('data:application/pdf;base64,') &&
        !JSON.stringify(out).includes('/Type /Page')
      );
    }
  ],
  [
    '未知二进制仍留占位,不解码成乱码',
    () => toChatMessages([{ role: 1, content: [{ value: '看看' }, { data: PNG, mimeType: 'application/octet-stream' }] }]),
    (out) =>
      typeof out[0]?.content === 'string' &&
      /application\/octet-stream/.test(out[0].content) &&
      !out[0].content.includes('IHDR')
  ],
  [
    '文本 DataPart 仍按文本拼接',
    () => toChatMessages([{ role: 1, content: [{ data: Buffer.from('hello'), mimeType: 'text/plain' }] }]),
    (out) => out[0]?.content === 'hello'
  ],
  [
    'assistant 的工具调用转成 tool_calls',
    () => toChatMessages([{ role: 2, content: [{ callId: 'c1', name: 'readFile', input: { path: '/a' } }] }]),
    (out) => out[0]?.role === 'assistant' && out[0].tool_calls?.[0].function.arguments === '{"path":"/a"}'
  ],
  [
    '工具结果转成 role:tool',
    () => toChatMessages([{ role: 1, content: [{ callId: 'c1', content: [{ value: '168' }] }] }]),
    (out) => out[0]?.role === 'tool' && out[0].tool_call_id === 'c1' && out[0].content === '168'
  ],
  [
    '工具结果里的图片补一条 user 消息带上去',
    () =>
      toChatMessages([
        { role: 1, content: [{ callId: 'c1', content: [{ value: '截图如下' }, { data: PNG, mimeType: 'image/png' }] }] }
      ]),
    (out) =>
      out[0]?.role === 'tool' &&
      out[1]?.role === 'user' &&
      Array.isArray(out[1].content) &&
      out[1].content.some((part) => part.type === 'image_url')
  ],
  [
    '工具结果里的 PDF 补一条 user 消息带上去',
    () =>
      toChatMessages([
        { role: 1, content: [{ callId: 'c1', content: [{ value: '报告如下' }, { data: PDF, mimeType: 'application/pdf' }] }] }
      ]),
    (out) =>
      out[0]?.role === 'tool' &&
      out[1]?.role === 'user' &&
      Array.isArray(out[1].content) &&
      out[1].content.some((part) => part.type === 'file')
  ]
];

let failed = 0;
for (const [label, run, check] of cases) {
  let out;
  let error;
  try {
    out = run();
  } catch (caught) {
    error = caught;
  }
  if (error || !check(out)) {
    failed += 1;
    console.log(`FAIL ${label}${error ? `\n  抛错: ${error.message}` : ''}`);
    console.log(`  ${JSON.stringify(out)?.slice(0, 300)}`);
    continue;
  }
  console.log(`ok   ${label}`);
}

// token 估算:工具结果、工具调用参数、图片都不能再算成 0。
const tokenCases = [
  ['4000 字符的工具结果', { role: 1, content: [{ callId: 'c1', content: [{ value: 'x'.repeat(4000) }] }] }, 900],
  ['工具调用参数', { role: 2, content: [{ callId: 'c1', name: 'write', input: { data: 'x'.repeat(2000) } }] }, 400],
  ['一张图片', { role: 1, content: [{ data: PNG, mimeType: 'image/png' }] }, 850],
  ['一页 PDF', { role: 1, content: [{ data: PDF, mimeType: 'application/pdf' }] }, 850],
  ['工具结果里的 PDF', { role: 1, content: [{ callId: 'c1', content: [{ data: PDF, mimeType: 'application/pdf' }] }] }, 850],
  ['纯中文 100 字', { role: 1, content: [{ value: '汉'.repeat(100) }] }, 75]
];
for (const [label, message, min] of tokenCases) {
  const tokens = estimateMessageTokens(message);
  if (tokens < min) {
    failed += 1;
    console.log(`FAIL token 估算: ${label} = ${tokens},应至少 ${min}`);
  } else {
    console.log(`ok   token 估算: ${label} = ${tokens}`);
  }
}

if (estimateTextTokens('') !== 0) {
  failed += 1;
  console.log('FAIL 空文本的 token 应为 0');
}

const pdfMessage = { role: 1, content: [{ callId: 'c1', content: [{ data: PDF, mimeType: 'application/pdf' }] }] };
if (messagePdfCount(pdfMessage) !== 1) {
  failed += 1;
  console.log(`FAIL messagePdfCount(工具结果里的 PDF) = ${messagePdfCount(pdfMessage)},期望 1`);
} else {
  console.log('ok   messagePdfCount 计入工具结果里的 PDF');
}

// 模型显示名:同名不同量化要能靠 detail 区分,名字里不再塞括号。
const { displayLabel, shortContext } = require('../dist/naming.js');
const labelCases = [
  ['unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M', { name: 'Qwen3.8-27B', family: 'qwen3.8-27b', badge: 'Q4_K_M' }],
  ['Qwen/Qwen3-32B', { name: 'Qwen3-32B', family: 'qwen3-32b', badge: undefined }],
  ['meta/Llama-3-8B:instruct', { name: 'Llama-3-8B', family: 'llama-3-8b', badge: 'instruct' }],
  ['local/model:Q8_0', { name: 'model', family: 'model', badge: 'Q8_0' }]
];
for (const [id, expected] of labelCases) {
  const label = displayLabel(id);
  const ok = label.name === expected.name && label.family === expected.family && label.badge === expected.badge;
  if (!ok) {
    failed += 1;
    console.log(`FAIL 模型名 ${id} -> ${JSON.stringify(label)}`);
  } else {
    console.log(`ok   模型名 ${id} -> ${label.name}${label.badge ? ` [${label.badge}]` : ''}`);
  }
}
for (const [tokens, expected] of [
  [32768, '32k'],
  [131072, '128k'],
  [512, '512']
]) {
  if (shortContext(tokens) !== expected) {
    failed += 1;
    console.log(`FAIL shortContext(${tokens}) = ${shortContext(tokens)},期望 ${expected}`);
  }
}

if (failed) {
  console.log(`\n${failed} 项失败`);
  process.exit(1);
}
console.log('\nOK');
