#!/usr/bin/env node
// 工具调用清洗的自检:坏参数/未知工具/重复调用都不能进 VS Code,
// 否则确认卡片会渲染失败并留下永远 pending 的 confirmations。
const { resolveToolCalls, parseArgs } = require('../dist/toolCalls.js');

const tools = [
  { name: 'readFile', schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'runInTerminal', schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  { name: 'problems', schema: { type: 'object', properties: {} } },
  { name: 'getTime' }
];

const cases = [
  ['截断的参数会被补全', [{ id: 'a', name: 'readFile', args: '{"path":"/tmp/a' }], (r) => r.calls.length === 1 && r.calls[0].input.path === '/tmp/a' && r.calls[0].repaired],
  ['缺必需参数的调用会被跳过', [{ id: 'b', name: 'runInTerminal', args: '{}' }], (r) => r.calls.length === 0 && /缺少必需参数/.test(r.skipped[0].reason)],
  ['未知工具名会被跳过', [{ id: 'c', name: 'delete_everything', args: '{}' }], (r) => r.calls.length === 0 && /不在本次提供的工具列表里/.test(r.skipped[0].reason)],
  ['下划线/大小写差异会对齐真实工具名', [{ id: 'd', name: 'read_file', args: '{"path":"/x"}' }], (r) => r.calls.length === 1 && r.calls[0].name === 'readFile'],
  ['完全相同的重复调用只保留一次', [{ id: 'e', name: 'problems', args: '{"a":1}' }, { id: 'f', name: 'problems', args: '{"a":1}' }], (r) => r.calls.length === 1 && r.skipped.length === 1],
  ['服务端返回重复 id 会被改名', [{ id: 'g', name: 'problems', args: '{"a":1}' }, { id: 'g', name: 'problems', args: '{"a":2}' }], (r) => r.calls[0].callId === 'g' && r.calls[1].callId === 'g_2'],
  ['没有工具名的片段会被跳过', [{ index: 0, args: '{"comm' }], (r) => r.calls.length === 0 && r.skipped.length === 1],
  ['无 schema 的工具允许空调用', [{ id: 'h', name: 'getTime', args: '' }], (r) => r.calls.length === 1],
  ['anyOf 分支的必需参数也能满足', [{ id: 'i', name: 'readFile', args: '{}' }], (r) => {
    const one = resolveToolCalls([{ id: 'i', name: 'readFile', args: '{}' }], [{ name: 'readFile', schema: { anyOf: [{ required: ['path'] }, { required: ['url'] }] } }]);
    return one.calls.length === 0 && r.calls.length === 0;
  }]
];

let failed = 0;
for (const [label, records, check] of cases) {
  const result = resolveToolCalls(records, tools);
  const ok = check(result);
  if (!ok) {
    failed += 1;
    console.log(`FAIL ${label}\n  calls=${JSON.stringify(result.calls)}\n  skipped=${JSON.stringify(result.skipped)}`);
  } else {
    console.log(`ok   ${label}`);
  }
}
const fences = parseArgs('```json\n{"path":"/x"}\n```');
if (!fences) { failed += 1; console.log('FAIL 代码块包裹的参数无法解析'); } else { console.log('ok   代码块包裹的参数会被截取'); }

// 性能回归:合法参数必须走「一次 parse」的快路径,修复路径也不能随长度平方爆炸。
// 之前的实现在 60 KB 合法参数上要 1.3 秒,直接把扩展主机卡住。
const bigGood = `{${Array.from({ length: 2000 }, (_, index) => `"k${index}":"${'v'.repeat(20)}"`).join(',')}}`;
const perfCases = [
  ['合法参数不触发修复', bigGood, false, 150],
  ['截断参数能修复且够快', bigGood.slice(0, -12), true, 600]
];
for (const [label, input, expectRepaired, budgetMs] of perfCases) {
  const started = process.hrtime.bigint();
  const parsed = parseArgs(input);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  const okRepaired = parsed ? parsed.repaired === expectRepaired : false;
  if (!parsed || !okRepaired || ms > budgetMs) {
    failed += 1;
    console.log(`FAIL ${label} ${(input.length / 1024).toFixed(1)} KB: ${ms.toFixed(1)} ms(repaired=${parsed ? parsed.repaired : 'n/a'})`);
  } else {
    console.log(`ok   ${label} ${(input.length / 1024).toFixed(1)} KB: ${ms.toFixed(1)} ms`);
  }
}

if (failed) {
  console.log(`\n${failed} 项失败`);
  process.exit(1);
}
console.log('\nOK');
