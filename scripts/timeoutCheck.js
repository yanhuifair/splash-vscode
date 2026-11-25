#!/usr/bin/env node
// 超时推导自检:VS Code 侧默认不重复配置,按 splash /status 推导。
const { deriveTimeouts } = require('../dist/timeouts.js');

const cases = [
  [
    '服务就绪 + 没排队 -> connect 30s',
    { weights: { idle_release_seconds: 600, released: false, restoring: false }, admission: { waiting: 0 }, scheduler: { queued: 0 }, latency: { http_request: { count: 131, sum: 1662 } } },
    (t) => t.connectMs === 30_000 && t.idleMs === 300_000 && t.totalMs === 0
  ],
  [
    '权重已卸载(默认 idle-release 10m)-> connect 至少 180s',
    { weights: { idle_release_seconds: 600, released: true }, admission: { waiting: 0 }, scheduler: { queued: 0 }, latency: { http_request: { count: 10, sum: 30 } } },
    (t) => t.connectMs === 180_000 && /权重已卸载/.test(t.notes[0])
  ],
  [
    '有请求排队 -> 每个排队请求加 15s',
    { weights: { released: false }, admission: { waiting: 3 }, scheduler: { queued: 2 }, latency: { http_request: { count: 5, sum: 10 } } },
    (t) => t.connectMs === 30_000 + 5 * 15_000
  ],
  [
    '历史请求平均 3 分钟 -> idle 取 5 倍 = 15min',
    { weights: { released: false }, latency: { http_request: { count: 4, sum: 720 } } },
    (t) => t.idleMs === 900_000
  ],
  [
    '历史请求很长 -> idle 封顶 30min',
    { weights: { released: false }, latency: { http_request: { count: 3, sum: 1_800 } } },
    (t) => t.idleMs === 1_800_000
  ],
  [
    '没有 /status -> 内置兜底 120s / 10min,总时长不限制',
    undefined,
    (t) => t.connectMs === 120_000 && t.idleMs === 600_000 && t.totalMs === 0
  ],
  [
    '设置里写死数字 -> 覆盖推导值',
    { weights: { released: false }, latency: { http_request: { count: 100, sum: 1000 } } },
    (t, value) => value.connectMs === 5_000 && value.idleMs === 45_000 && value.totalMs === 90_000,
    { connectTimeoutMs: 5_000, idleTimeoutMs: 45_000, requestTimeoutMs: 90_000 }
  ],
  [
    '-1 -> 该项完全关闭(不限制)',
    { weights: { released: false } },
    (t, value) => value.connectMs === 0 && value.idleMs === 0 && /已关闭/.test(t.notes.join(' ')),
    { connectTimeoutMs: -1, idleTimeoutMs: -1, requestTimeoutMs: -1 }
  ]
];

const AUTO = { connectTimeoutMs: 0, idleTimeoutMs: 0, requestTimeoutMs: 0 };
let failed = 0;
for (const [label, status, check, settings] of cases) {
  const value = deriveTimeouts(settings ?? AUTO, status);
  if (!check(value, value === undefined ? undefined : value)) {
    failed += 1;
    console.log(`FAIL ${label}\n  ${JSON.stringify(value)}`);
    continue;
  }
  console.log(`ok   ${label}`);
  console.log(`     connect=${value.connectMs} idle=${value.idleMs} total=${value.totalMs}${value.notes.length ? ` | ${value.notes.join(' | ')}` : ''}`);
}
if (failed) {
  console.log(`\n${failed} 项失败`);
  process.exit(1);
}
console.log('\nOK');
