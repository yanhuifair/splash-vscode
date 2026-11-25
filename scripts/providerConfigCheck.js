#!/usr/bin/env node
// Provider 配置组自检:解析 options.configuration、secret 字段声明、组隔离 key、自定义 header。
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { readProviderConfig, readStringRecord, groupKey } = require('../dist/providerConfig.js');
const { SplashClient } = require('../dist/client.js');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
let failed = 0;

function check(label, condition) {
  if (condition) {
    console.log(`ok   ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL ${label}`);
  }
}

check('没有 configuration 时返回 undefined', readProviderConfig({ silent: true }) === undefined);

const parsed = readProviderConfig({
  silent: false,
  configuration: {
    url: ' http://127.0.0.1:8060 ',
    models: ['a:b', '', 42],
    headers: { 'X-Gateway': 'splash', 'X-Bad': 7 },
    apiKey: ' secret-value '
  }
});
check('配置组 URL 去空白', parsed?.url === 'http://127.0.0.1:8060');
check('模型白名单只保留非空字符串', JSON.stringify(parsed?.models) === JSON.stringify(['a:b']));
check('header 只保留字符串值', JSON.stringify(parsed?.headers) === JSON.stringify({ 'X-Gateway': 'splash' }));
check('secret apiKey 去空白', parsed?.apiKey === 'secret-value');
check('非对象 header 被忽略', Object.keys(readStringRecord(['x'])).length === 0);

check('空配置不产生组 key', groupKey(undefined) === '' && groupKey(readProviderConfig({ configuration: {} })) === '');
const keyA = groupKey({ url: 'http://a' });
const keyB = groupKey({ url: 'http://b' });
const keySecret = groupKey({ url: 'http://a', apiKey: 'secret-value' });
check('不同地址是不同组', Boolean(keyA) && keyA !== keyB);
check('同地址不同密钥是不同组', keyA !== keySecret);
check('组 key 不含明文密钥', !String(keySecret).includes('secret-value'));

const provider = pkg.contributes.languageModelChatProviders[0];
const props = provider.configuration?.properties ?? {};
check('provider 声明 url/models/headers/apiKey', ['url', 'models', 'headers', 'apiKey'].every((name) => Boolean(props[name])));
check('provider apiKey 标记 secret', props.apiKey?.secret === true);
check('workspace 仍有 splash.headers 回退', Boolean(pkg.contributes.configuration.properties['splash.headers']));

function withServer(handler, run) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', async () => {
      try {
        await run(`http://127.0.0.1:${server.address().port}`);
      } finally {
        server.close();
        server.closeAllConnections?.();
        resolve();
      }
    });
  });
}

(async () => {
  await withServer(
    (req, res) => {
      if (req.headers['x-gateway'] !== 'splash' || req.headers.authorization !== 'Bearer k') {
        res.writeHead(400);
        res.end('{"error":{"message":"missing header"}}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"data":[]}');
    },
    async (baseUrl) => {
      const client = new SplashClient(baseUrl, 'k', { connectMs: 2_000, idleMs: 2_000, totalMs: 5_000 }, { 'X-Gateway': 'splash' });
      const models = await client.listModels();
      check('自定义 header 与 Bearer 同时下发', Array.isArray(models));
    }
  );

  if (failed) {
    console.log(`\n${failed} 项失败`);
    process.exit(1);
  }
  console.log('\nOK');
})();
