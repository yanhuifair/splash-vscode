#!/usr/bin/env node
// 按模型思考强度自检:优先级、布尔值语义、不支持级别的处理。
const { readThinkingLevels, resolveThinkingLevel } = require('../dist/thinking.js');

let failed = 0;
function check(label, condition) {
  if (condition) {
    console.log(`ok   ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL ${label}`);
  }
}

const levels = readThinkingLevels({ 'm:Q8': 'low', off: false, on: true, bad: 42, empty: '' });
check('配置只保留字符串与布尔', JSON.stringify(levels) === JSON.stringify({ 'm:Q8': 'low', off: false, on: true, empty: '' }));

const efforts = ['low', 'medium', 'xhigh'];
check(
  'thinkingLevels 覆盖全局设置',
  resolveThinkingLevel('m:Q8', undefined, { 'm:Q8': 'low' }, 'xhigh', efforts).level === 'low'
);
check(
  'modelOptions 优先级最高',
  resolveThinkingLevel('m:Q8', { reasoningEffort: 'xhigh' }, { 'm:Q8': 'low' }, 'server', efforts).level === 'xhigh'
);
check(
  'false 下发 none',
  resolveThinkingLevel('m:Q8', undefined, { 'm:Q8': false }, 'xhigh', efforts).level === 'none'
);
check(
  'true 与 server 都不下发参数',
  resolveThinkingLevel('m:Q8', undefined, { 'm:Q8': true }, 'xhigh', efforts).level === undefined &&
    resolveThinkingLevel('m:Q8', undefined, {}, 'server', efforts).level === undefined
);
check(
  'none 即使不在 efforts 里也允许',
  resolveThinkingLevel('m:Q8', undefined, { 'm:Q8': 'none' }, 'xhigh', efforts).supported === true
);
const unsupported = resolveThinkingLevel('m:Q8', undefined, { 'm:Q8': 'high' }, 'xhigh', efforts);
check('不支持的级别被忽略且给出原因', unsupported.level === undefined && !unsupported.supported && /只声明/.test(unsupported.note));
check('没有 efforts 时信任模型级配置', resolveThinkingLevel('m:Q8', undefined, { 'm:Q8': 'high' }, 'server', []).level === 'high');
check('来源写进诊断说明', /来源 thinkingLevels/.test(resolveThinkingLevel('m:Q8', undefined, { 'm:Q8': 'low' }, 'server', efforts).note));

if (failed) {
  console.log(`\n${failed} 项失败`);
  process.exit(1);
}
console.log('\nOK');
