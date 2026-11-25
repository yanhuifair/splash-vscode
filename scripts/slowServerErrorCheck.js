#!/usr/bin/env node
// 错误分类自检:服务在线但慢,不能被报成「无法连接,请先运行 splash serve」。
const http = require('node:http');
const { SplashClient, SplashError, SplashTimeoutError, normalizeBaseUrl } = require('../dist/client.js');

const request = { model: 'm', messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 };

// 地址规范化:用户把整条兼容端点(.../v1)贴进来时,请求路径自带 /v1,不能拼成 /v1/v1。
for (const [input, expected] of [
  ['127.0.0.1:8000', 'http://127.0.0.1:8000'],
  ['http://127.0.0.1:8000/v1/', 'http://127.0.0.1:8000'],
  ['http://127.0.0.1:8000///', 'http://127.0.0.1:8000'],
  ['', 'http://127.0.0.1:8000']
]) {
  const actual = normalizeBaseUrl(input);
  if (actual !== expected) {
    console.log(`FAIL normalizeBaseUrl(${JSON.stringify(input)}) = ${actual},期望 ${expected}`);
    process.exitCode = 1;
  } else {
    console.log(`ok   normalizeBaseUrl(${JSON.stringify(input)}) = ${actual}`);
  }
}

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
}

function sseHead(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write('data: {"choices":[{"delta":{"content":"部分输出"}}]}\n\n');
}

async function failure(run) {
  try {
    await run();
    return undefined;
  } catch (error) {
    return error;
  }
}

async function withServer(handler, run) {
  const server = await listen(handler);
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await close(server);
  }
}

function sseDone(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write('data: {"choices":[{"delta":{"content":"OK"}}]}\n\n');
  res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
  res.write('data: [DONE]\n\n');
  res.end();
}

const cases = [
  [
    '响应头迟迟不来 -> connect 超时(不是连不上)',
    () =>
      withServer(
        (_req, res) => setTimeout(() => res.end('{"choices":[]}'), 1_500),
        (baseUrl) => new SplashClient(baseUrl, undefined, { connectMs: 300, idleMs: 1_000, totalMs: 5_000 }).streamChat(request, () => {})
      ),
    (error) => error instanceof SplashTimeoutError && error.kind === 'connect' && /没有应答/.test(error.message) && /加载模型/.test(error.message)
  ],
  [
    '流式回复中途断流 -> idle 超时',
    () =>
      withServer(
        (_req, res) => {
          sseHead(res);
          // 故意不再写任何东西
        },
        (baseUrl) => {
          let chunks = 0;
          return new SplashClient(baseUrl, undefined, { connectMs: 500, idleMs: 400, totalMs: 6_000 })
            .streamChat(request, () => (chunks += 1))
            .then(() => {
              throw new Error('没超时');
            })
            .catch((error) => {
              if (!chunks) {
                throw new Error('断流前应该已经收到数据块');
              }
              throw error;
            });
        }
      ),
    (error) => error instanceof SplashTimeoutError && error.kind === 'idle' && /没有新输出/.test(error.message)
  ],
  [
    '一直有输出但超过总上限 -> total 超时',
    () =>
      withServer(
        (_req, res) => {
          sseHead(res);
          const timer = setInterval(() => res.write(': keep\n\n'), 100);
          res.on('close', () => clearInterval(timer));
        },
        (baseUrl) => new SplashClient(baseUrl, undefined, { connectMs: 500, idleMs: 1_000, totalMs: 700 }).streamChat(request, () => {})
      ),
    (error) => error instanceof SplashTimeoutError && error.kind === 'total' && /超过 700 ms/.test(error.message)
  ],
  [
    '端口没人监听 -> 才说无法连接',
    async () => {
      const server = await listen((_req, res) => res.end());
      const port = server.address().port;
      await close(server);
      return new SplashClient(`http://127.0.0.1:${port}`, undefined, { connectMs: 2_000, idleMs: 2_000, totalMs: 2_000 }).streamChat(request, () => {});
    },
    (error) => !(error instanceof SplashTimeoutError) && error instanceof SplashError && /无法连接 splash/.test(error.message)
  ],
  [
    '服务返回 500 -> 带上状态码,不再静默空回复',
    () =>
      withServer(
        (_req, res) => {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end('{"error":{"message":"context length exceeded"}}');
        },
        (baseUrl) => new SplashClient(baseUrl, undefined, { connectMs: 2_000, idleMs: 2_000, totalMs: 5_000 }).streamChat(request, () => {})
      ),
    (error) => error instanceof SplashError && !(error instanceof SplashTimeoutError) && /500/.test(error.message) && /context length exceeded/.test(error.detail ?? '')
  ],
  [
    '非流式请求慢 -> /v1/models 也说清楚是慢不是没启动',
    () =>
      withServer(
        (_req, res) => setTimeout(() => res.end('{"data":[]}'), 1_500),
        (baseUrl) => new SplashClient(baseUrl, undefined, { connectMs: 300, idleMs: 1_000, totalMs: 5_000 }).listModels()
      ),
    (error) => error instanceof SplashTimeoutError && error.kind === 'connect' && /GET \/v1\/models/.test(error.message)
  ],
  [
    'connectTimeoutMs=0 时不限制等待(卸载权重后重载模型不会被误杀)',
    () =>
      withServer(
        (_req, res) => setTimeout(() => sseDone(res), 900),
        (baseUrl) => new SplashClient(baseUrl, undefined, { connectMs: 0, idleMs: 0, totalMs: 0 }).streamChat(request, () => {})
      ),
    (error) => error === undefined
  ],
  [
    'idleTimeoutMs=0 时不限制断流(超长 prefill 不会被砍)',
    () =>
      withServer(
        (_req, res) => {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('data: {"choices":[{"delta":{"content":"先"}}]}\n\n');
          setTimeout(() => {
            res.write('data: {"choices":[{"delta":{"content":"后"}}]}\n\n');
            res.write('data: [DONE]\n\n');
            res.end();
          }, 1_200);
        },
        (baseUrl) => new SplashClient(baseUrl, undefined, { connectMs: 0, idleMs: 0, totalMs: 0 }).streamChat(request, () => {})
      ),
    (error) => error === undefined
  ],
  [
    '服务端 --request-timeout 的 504 会原样报出来(不再被客户端超时抢话)',
    () =>
      withServer(
        (_req, res) => {
          res.writeHead(504, { 'content-type': 'application/json' });
          res.end('{"error":{"message":"Request timed out"}}');
        },
        (baseUrl) => new SplashClient(baseUrl, undefined, { connectMs: 120_000, idleMs: 600_000, totalMs: 0 }).streamChat(request, () => {})
      ),
    (error) => error instanceof SplashError && !(error instanceof SplashTimeoutError) && /504/.test(error.message) && /Request timed out/.test(error.detail ?? '')
  ],
  [
    '只有心跳(SSE 注释行)也算断流 -> idle 超时',
    () =>
      withServer(
        (_req, res) => {
          sseHead(res);
          const timer = setInterval(() => res.write(': keep-alive\n\n'), 100);
          res.on('close', () => clearInterval(timer));
        },
        (baseUrl) => new SplashClient(baseUrl, undefined, { connectMs: 1_000, idleMs: 400, totalMs: 5_000 }).streamChat(request, () => {})
      ),
    (error) => error instanceof SplashTimeoutError && error.kind === 'idle' && /没有新输出/.test(error.message)
  ],
  [
    '服务端不认 stream_options(400)-> 去掉它自动重试一次',
    () =>
      withServer(
        (req, res) => {
          let body = '';
          req.on('data', (chunk) => (body += chunk));
          req.on('end', () => {
            if (body.includes('stream_options')) {
              res.writeHead(400, { 'content-type': 'application/json' });
              res.end('{"error":{"message":"unknown field stream_options"}}');
              return;
            }
            sseDone(res);
          });
        },
        (baseUrl) => {
          let text = '';
          return new SplashClient(baseUrl, undefined, { connectMs: 2_000, idleMs: 2_000, totalMs: 5_000 })
            .streamChat(request, (chunk) => (text += chunk.text ?? ''))
            .then(() => {
              if (text !== 'OK') {
                throw new Error(`重试后没拿到正文: ${JSON.stringify(text)}`);
              }
            });
        }
      ),
    (error) => error === undefined
  ],
  [
    '连接被重置(请求没发出去)-> 自动重试一次并成功',
    () => {
      let attempts = 0;
      return withServer(
        (_req, res) => {
          attempts += 1;
          if (attempts === 1) {
            res.socket?.destroy();
            return;
          }
          sseDone(res);
        },
        (baseUrl) => {
          let text = '';
          return new SplashClient(baseUrl, undefined, { connectMs: 2_000, idleMs: 2_000, totalMs: 5_000 })
            .streamChat(request, (chunk) => (text += chunk.text ?? ''))
            .then(() => {
              if (text !== 'OK') {
                throw new Error(`重试后没拿到正文: ${JSON.stringify(text)}`);
              }
            });
        }
      );
    },
    (error) => error === undefined
  ],
  [
    '连接重置后第二次又遇 stream_options 400 -> 仍能降级重试成功',
    () => {
      let attempts = 0;
      return withServer(
        (req, res) => {
          attempts += 1;
          if (attempts === 1) {
            res.socket?.destroy();
            return;
          }
          let body = '';
          req.on('data', (chunk) => (body += chunk));
          req.on('end', () => {
            if (body.includes('stream_options')) {
              res.writeHead(400, { 'content-type': 'application/json' });
              res.end('{"error":{"message":"unknown field stream_options"}}');
              return;
            }
            sseDone(res);
          });
        },
        (baseUrl) => {
          let text = '';
          return new SplashClient(baseUrl, undefined, { connectMs: 2_000, idleMs: 2_000, totalMs: 5_000 })
            .streamChat(request, (chunk) => (text += chunk.text ?? ''))
            .then(() => {
              if (text !== 'OK') {
                throw new Error(`降级重试后没拿到正文: ${JSON.stringify(text)}`);
              }
              if (attempts !== 3) {
                throw new Error(`请求次数 ${attempts},期望 3(连接重试 + stream_options 降级)`);
              }
            });
        }
      );
    },
    (error) => error === undefined
  ]
];

(async () => {
  let failed = 0;
  for (const [label, run, check] of cases) {
    const error = await failure(run);
    if (!check(error)) {
      failed += 1;
      console.log(
        error
          ? `FAIL ${label}\n  name=${error.name}\n  message=${error.message}\n  detail=${error.detail ?? ''}`
          : `FAIL ${label}\n  没有抛出错误`
      );
      continue;
    }
    console.log(`ok   ${label}`);
    console.log(`     → ${error ? error.message : '请求正常完成,没有被超时打断'}`);
  }

  if (failed) {
    console.log(`\n${failed} 项失败`);
    process.exit(1);
  }
  console.log('\nOK');
})();
