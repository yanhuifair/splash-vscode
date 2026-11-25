#!/usr/bin/env node
// 统一自检入口:编译 + 依次跑全部离线检查,任一失败即退出非 0。
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const checks = [
  ['消息转换 / token 估算', 'openaiCheck.js'],
  ['Provider 配置组与自定义 header', 'providerConfigCheck.js'],
  ['工具调用清洗与修复', 'toolCallsCheck.js'],
  ['按模型思考强度', 'thinkingCheck.js'],
  ['超时推导', 'timeoutCheck.js'],
  ['慢服务 / 错误分类 / 重试', 'slowServerErrorCheck.js']
];

const tsc = path.join(root, 'node_modules', '.bin', 'tsc');
const compile = spawnSync(tsc, ['-p', '.'], { cwd: root, encoding: 'utf8' });
if (compile.status !== 0) {
  console.error(`编译失败\n${(compile.stdout || compile.stderr || '').trim()}`);
  process.exit(1);
}
console.log('✔ 编译');

const failed = [];
for (const [label, file] of checks) {
  const started = Date.now();
  const run = spawnSync(process.execPath, [path.join(__dirname, file)], { cwd: root, encoding: 'utf8' });
  const ms = Date.now() - started;
  if (run.status !== 0) {
    failed.push(label);
    console.error(`✘ ${label} (${ms} ms)`);
    console.error((run.stdout || run.stderr || '').trim());
    continue;
  }
  console.log(`✔ ${label} (${ms} ms)`);
}

if (failed.length) {
  console.error(`\n${failed.length} 组检查失败: ${failed.join('、')}`);
  process.exit(1);
}
console.log('\n全部通过。真实链路冒烟还需要 splash 在跑: npm run smoke');
