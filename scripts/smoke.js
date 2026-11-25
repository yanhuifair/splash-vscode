// 冒烟测试:需要本地 splash 已启动。用法: npm run compile && npm run smoke
const { SplashClient } = require('../dist/client.js');
const { toChatMessages, toToolSpecs } = require('../dist/openai.js');

const base = process.env.SPLASH_BASE_URL || 'http://127.0.0.1:8000';
const apiKey = process.env.SPLASH_API_KEY || undefined;

/** 造一个最小的单页 PDF,用来验证 file part 链路。 */
function tinyPdf(label) {
  const stream = `BT /F1 24 Tf 20 100 Td (${label}) Tj ET\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  const chunks = [Buffer.from('%PDF-1.4\n')];
  const offsets = [];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.concat(chunks).length);
    chunks.push(Buffer.from(`${index + 1} 0 obj\n${objects[index]}\nendobj\n`));
  }
  const xref = Buffer.concat(chunks).length;
  let trailer = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    trailer += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  trailer += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.concat([...chunks, Buffer.from(trailer)]);
}

(async () => {
  const client = new SplashClient(base, apiKey);
  console.log('health:', await client.health());
  const models = await client.listModels();
  if (!models.length) {
    throw new Error('没有可用模型,请先 splash serve --model ...');
  }
  const model = models[0].id;
  console.log('model:', model, '| ctx:', models[0].context_length, '| vision:', models[0].vision);
  console.log('tokenize("hello world"):', await client.countTokens('hello world'));

  let text = '';
  let reasoning = 0;
  await client.streamChat({ model, messages: [{ role: 'user', content: 'Say exactly: SPLASH-OK' }], max_tokens: 400, reasoning_effort: 'low' }, (chunk) => {
    text += chunk.text ?? '';
    reasoning += chunk.reasoning?.length ?? 0;
  });
  console.log('text:', JSON.stringify(text), '| reasoning chars:', reasoning);

  let noThinkText = '';
  let noThinkReasoning = 0;
  await client.streamChat({ model, messages: [{ role: 'user', content: 'Say exactly: NO-THINK' }], max_tokens: 100, reasoning_effort: 'none' }, (chunk) => {
    noThinkText += chunk.text ?? '';
    noThinkReasoning += chunk.reasoning?.length ?? 0;
  });
  console.log('reasoning_effort=none:', JSON.stringify(noThinkText), '| reasoning chars:', noThinkReasoning);

  const tools = toToolSpecs([{ name: 'calculator', description: 'Evaluate arithmetic', inputSchema: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] } }]);
  const calls = new Map();
  await client.streamChat({ model, messages: [{ role: 'user', content: 'What is 24*7? You must call the calculator tool.' }], tools, tool_choice: 'auto', max_tokens: 400, reasoning_effort: 'low' }, (chunk) => {
    for (const call of chunk.toolCalls ?? []) {
      const entry = calls.get(call.index) ?? { args: '' };
      entry.id = call.id ?? entry.id;
      entry.name = call.name ?? entry.name;
      entry.args += call.arguments ?? '';
      calls.set(call.index, entry);
    }
  });
  console.log('tool calls:', JSON.stringify([...calls.values()]));

  if (models[0].vision) {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    let vision = '';
    await client.streamChat({ model, max_tokens: 400, reasoning_effort: 'low', messages: [{ role: 'user', content: [{ type: 'text', text: 'What color is this image? One word.' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } }] }] }, (chunk) => { vision += chunk.text ?? ''; });
    console.log('vision:', JSON.stringify(vision));

    const pdf = tinyPdf('PDF-OK');
    let document = '';
    await client.streamChat({ model, max_tokens: 400, reasoning_effort: 'low', messages: [{ role: 'user', content: [{ type: 'text', text: 'What word is printed in the PDF? Reply one word.' }, { type: 'file', file: { file_data: `data:application/pdf;base64,${pdf.toString('base64')}` } }] }] }, (chunk) => { document += chunk.text ?? ''; });
    console.log('pdf:', JSON.stringify(document));
  }

  console.log('converted messages:', JSON.stringify(toChatMessages([
    { role: 1, content: [{ value: 'run it' }] },
    { role: 2, content: [{ callId: 'c1', name: 'calculator', input: { expression: '24*7' } }] },
    { role: 1, content: [{ callId: 'c1', content: [{ value: '168' }] }] }
  ])));
  console.log('OK');
})().catch((error) => {
  console.error('FAILED:', error.message);
  process.exit(1);
});
