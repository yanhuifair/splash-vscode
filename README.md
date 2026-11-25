# Splash for VS Code

仓库:[yanhuifair/splash-vscode](https://github.com/yanhuifair/splash-vscode)

把本地 `splash` 服务接进 VS Code 的聊天模型体系:模型选择器里出现 `Splash` 分组,其它扩展也能用
`vscode.lm.selectChatModels({ vendor: 'splash' })` 调用它。

支持:流式输出、思考内容(`reasoning_content`)、工具调用(function calling)、图片输入(视觉模型)、PDF 输入(模型支持视觉时)。

> 前置条件:splash 已在本地跑起来,VS Code ≥ 1.104(Model Provider API 稳定版)。

---

## 快速开始

**1. 启动 splash**

```bash
splash serve --model unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M
# 默认监听 127.0.0.1:8000;换端口 --port 8001;需要鉴权 --api-key xxx
```

**2. 安装扩展**(编译 → 打包 `build/splash-model-provider.vsix` → `code --install-extension --force`)

```bash
npm install
npm run install-ext
```

**3. 重载窗口并使用**:命令面板执行 `Developer: Reload Window`,聊天面板里选 `Splash` 分组下的模型。
状态栏会显示 `Splash · <模型名>`,点它可以检查服务状态。

---

## 日常开发

```bash
npm run dev
# 监视 src/**/*.ts 与 package.json:保存 → tsc 编译 → vsce 打包 → 装到本机 VS Code(约 1.3s/次)
```

每次装完仍需重载扩展主机(`Developer: Reload Window`)。建议绑个快捷键,`keybindings.json`:

```jsonc
{ "key": "ctrl+cmd+r", "command": "workbench.action.reloadWindow" }
```

改完代码提交前跑 `npm run verify`(eslint + 编译 + 全部离线检查),比装完再去聊天里试快得多。

其它提示:

- 只验证单处改动时,按 F5 起 Extension Development Host 更快(改完 `Cmd+R` 重载,不必打包安装)。
- 用 Insiders/Cursor,或 PATH 里没有 `code`:设 `CODE_CLI="/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code"`,
  或命令面板执行 `Shell Command: Install 'code' command in PATH`。`install.js` 也会自动探测常见路径。
- 打包产物统一在 `build/`(已 gitignore),根目录不散落 vsix。

---

## 使用

1. 模型选择器里选 `Splash` 分组下的模型;看不到就先执行 `Splash: 刷新模型列表`。
   同一个模型的量化档和上下文放在名字右侧(`Qwen3.8-27B · Q4_K_M · 32k`),不用展开 tooltip 就能区分。
2. Agent/工具模式下模型被标记为支持工具调用,VS Code 会把工具列表一并发给 splash
   (不想要就关 `splash.enableTools`)。
3. 思考内容默认**不显示**(`splash.reasoningMode: off`);想看就切 `stream` 或 `final`,
   代价是它会被当作正文留在会话历史里。
4. 状态栏在请求期间会变成 `$(sync~spin) Splash · 等待响应` / `生成中`:本地模型首字慢的时候,
   能立刻分清「在加载权重」还是「扩展没反应」。失败则显示 `$(error) Splash · 请求失败` 十秒,
   点一下直接查服务状态。生成结束回到当前模型名(显示的是最近真正用过的那个)。

## 命令

| 命令 | 作用 |
| --- | --- |
| `Splash: 刷新模型列表` | 重新读 `/v1/models`,刷新聊天模型选择器 |
| `Splash: 检查本地服务状态` | 探测 `/health` 与模型列表,结果输出到提示和 Output 面板 `Splash` 频道 |
| `Splash: 设置 API Key(存系统钥匙串)` | 把 `--api-key` 写进系统钥匙串,不再明文落在 `settings.json`(留空回车即清除) |
| `Splash: 管理 Splash 模型` | 统一入口:检查服务 / 诊断模型 / 设置 Key / 刷新模型 / 日志 / 设置。也出现在模型选择器的齿轮菜单里 |
| `Splash: 诊断模型` | 输出配置来源、VS Code 模型列表、直接 `/health` + `/v1/models` 探测结果和思考强度策略到 `Splash` 频道 |
| `Splash: 打开日志` | 打开 Output 面板 `Splash` 频道(排查看这里最快) |

---

## 配置组(推荐)

VS Code 1.127+ 可在「管理模型」里为 Splash 添加任意多个配置组,分别连接不同的 `splash serve`:

1. 聊天模型选择器 → 齿轮 → **Manage Language Models** → Add Models → 选 **Splash**。
2. 填写组名,并在配置里设置:

| 字段 | 作用 |
| --- | --- |
| `url` | 该组的 splash 地址,优先于 `splash.baseUrl` |
| `models` | 完整模型 ID 白名单;留空则使用服务返回的全部模型 |
| `headers` | 模型发现与聊天请求都带上的自定义 header(反代/网关鉴权) |
| `apiKey` | 对应 `--api-key`,由 VS Code 安全存储,优先于钥匙串和 `splash.apiKey` |

每组的模型列表、超时推导、token 缓存和 `/tokenize` 冷却都是**独立**的;请求会回到该模型所属的地址和密钥,不会串组。`Splash: 管理 Splash 模型` 命令(齿轮入口)保留作旧版本兼容。

---

## 设置项

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `splash.baseUrl` | `http://127.0.0.1:8000` | 对应 `splash serve --host/--port`;末尾的 `/v1` 会被自动去掉 |
| `splash.apiKey` | `""` | 对应 `splash serve --api-key`。明文设置,建议改用钥匙串命令或配置组的 `apiKey` |
| `splash.headers` | `{}` | 所有请求附带的自定义 HTTP header;配置组里的 `headers` 优先 |
| `splash.modelFilter` | `""` | 逗号分隔关键词,只保留模型 ID 命中的模型 |
| `splash.maxOutputTokens` | `8192` | 单次回复上限,同时从上下文里预留 |
| `splash.temperature` | `null` | `null` = 用服务端默认值 |
| `splash.reasoningEffort` | `server` | `none`/`minimal`/`low`/`medium`/`high`/`xhigh`;`server` = 不下发该参数 |
| `splash.thinkingLevels` | `{}` | 按完整模型 ID 覆盖思考强度;`true`=服务端默认、`false`=关闭思考。优先级高于全局设置,低于调用方显式参数 |
| `splash.reasoningMode` | `off` | 思考内容显示方式:`off` 不显示(默认) / `stream` 实时流式 / `final` 结尾一次性。**只有 `off` 不占上下文**,原因见[思考内容](#思考内容reasoning_content) |
| `splash.serverTokenizer` | `true` | 用 splash `/tokenize` 精确统计 token(否则按字符估算) |
| `splash.enableTools` | `true` | 是否声明支持工具调用。小模型在 Agent 模式被上百个工具压垮时,关掉它比调超时更有效 |
| `splash.maxToolsPerRequest` | `0` = 不限制 | 单请求最多下发多少个工具。`>0` 时同时写入模型能力声明并在本地截断工具列表 |
| `splash.connectTimeoutMs` | `0` = 跟随服务 | 等服务端开始应答(响应头),详见[超时策略](#超时策略) |
| `splash.idleTimeoutMs` | `0` = 跟随服务 | 流式回复相邻两块数据的最大间隔,详见[超时策略](#超时策略) |
| `splash.requestTimeoutMs` | `0` = 不限制 | 总上限交给 `splash serve --request-timeout` |
| `splash.showStatusBar` | `true` | 状态栏指示器 |

---

## 超时策略

一次请求的超时被拆成三段,三项设置的语义一致:**`0` = 跟随服务(默认)、`-1` = 关闭该项、`>0` = 手动固定毫秒数**。
推导逻辑在 `src/timeouts.ts`,输入是 splash `/status` 的实时状态:

| 段 | 含义 | 跟随服务时怎么算 |
| --- | --- | --- |
| `connect` | 服务端开始应答(响应头) | 就绪 30s;`weights.released/restoring` 180s;每个排队请求(admission.waiting + scheduler.queued)+15s;上限 15min |
| `idle` | 流式回复相邻两块数据的间隔 | 取历史请求平均耗时 `latency.http_request` 的 5 倍,限 5–30 分钟 |
| `total` | 整条请求上限 | 不限制,交给 `splash serve --request-timeout`;服务端到期返回 504,扩展原样报状态码 + 响应体 |

- 拿不到 `/status` 时用兜底值:connect 120s、idle 600s。
- 推导结果打在 Output 面板 `Splash`:`超时 connect=… idle=… total=…`,可核对是否符合预期。
- 想改行为优先调 splash 参数(`--idle-release`、`--request-timeout`、`--queue-size`),而不是在 VS Code 里填数字。
- 超时后扩展会顺带探一次 `/health`,明确区分「在线但慢/正在加载模型」和「真的没启动」。

---

## 自测

纯函数/本地假服务器的检查不联网,可随时跑;真实链路冒烟需要 splash 在跑。

```bash
npm run verify   # eslint + 编译 + 全部离线检查,提交前跑这一条
npm test         # 只跑编译 + 离线检查
npm run lint     # 只跑 eslint
```

| 命令 | 覆盖内容 | 需要 splash |
| --- | --- | --- |
| `npm run smoke` | 真实链路:health / models / tokenize / 流式 / 思考 / 工具调用 / 视觉 / PDF | 是 |
| `npm run smoke:openai` | 消息转换:图片/PDF(data part)、工具结果、token 估算、模型显示名(纯函数) | 否 |
| `npm test` 内置检查 | Provider 配置组解析、secret 声明、组隔离 key、自定义 header、按模型思考强度优先级 | 否 |
| `npm run smoke:tools` | 工具调用清洗 + 参数修复耗时(纯函数) | 否 |
| `npm run smoke:slow` | 慢服务、错误分类、SSE 心跳、`stream_options` 与连接重置重试(本地假服务器) | 否 |
| `npm run smoke:timeouts` | 超时推导(纯函数) | 否 |

冒烟测试可换地址:

```bash
SPLASH_BASE_URL=http://127.0.0.1:8001 SPLASH_API_KEY=xxx npm run smoke
```

---

## 实现要点

**接入方式**(`src/extension.ts`、`src/provider.ts`)

- 贡献点 `languageModelChatProviders`(`vendor: splash`)+ `vscode.lm.registerLanguageModelChatProvider`,
  即 VS Code 1.104+ 的稳定 Model Provider API;`engines.vscode` 锁 `^1.104.0`。
  `onStartupFinished` 让扩展在窗口启动后即可激活,状态栏和模型列表更早可用。
- 1.127+ 的 provider `configuration`(`options.configuration`)支持多个配置组;每组独立缓存地址、白名单、
  header、密钥、超时与 token 数,`secret: true` 的 `apiKey` 只参与组 key 哈希,不会写进日志。
- 模型元数据来自 `/v1/models` 的 `context_length`、`vision`、`input_modalities`、`reasoning.efforts`,
  用于填 VS Code 的 `maxInputTokens` / `capabilities`。
- `LanguageModelChatRequestMessage` → OpenAI 消息:工具结果转 `role: "tool"`,图片转 `image_url` 的 data URL、
  PDF(`application/pdf` 的 `LanguageModelDataPart`)转 splash 的 `{"type":"file"}` part;工具结果里附带的图片/PDF
  会紧跟一条 `user` 消息带上去,不会被 `role: "tool"` 丢掉。
- 图片 part 的 MIME 取自 `LanguageModelDataPart.mimeType`(VS Code 的字段名);认不出的二进制
  (PDF 等)只留 `[application/pdf 数据, N 字节]` 占位,不会把字节当文本塞进提示词。
- 工具返回的图片没法塞进 `role: "tool"`(OpenAI 只收字符串),会紧跟一条 `user` 消息带上去,
  否则截图类工具的视觉结果就白丢了。
- `provideTokenCount` 按 part 分别估算:工具结果、工具调用参数都计入,图片按 850 token/张、
  PDF 按 850 token/页(最多按 64 页估);含图片或 PDF 的消息跳过 `/tokenize`,避免把媒体算成 0。
  纯文本里 CJK 按 0.75 token/字、其余按 4 字符/token。结果用文本哈希缓存,
  `/tokenize` 失败后 60 秒内直接用估算(服务在加载权重时不会把上下文计算拖死)。
- 图标 `images/icon.png`(256×256,由 `AppIcon.icns` 导出:`iconutil -c iconset AppIcon.icns -o /tmp/AppIcon.iconset`);
  provider 图标用 `languageModelChatProviders[].icon` 的 `{ light, dark }` 形式指向同一张图。

**思考内容**(`reasoning_content`)

- **默认 `off`**。原因:思考内容即使以原生块显示,也仍然会参与生成;`stream`/`final` 在老版本 VS Code 里
  只能当**正文文本**发出去 —— 它会留在会话历史里,下一轮再发给模型,每轮白烧几百到几千 token。
  本地模型上下文本来就紧,所以默认关掉。
- 打开后:VS Code 1.147 的扩展主机已暴露 `LanguageModelThinkingPart`(虽未写进公开 d.ts),
  扩展会自动探测并直接使用原生可折叠思考块;老版本退化为 Markdown 引用块,
  并且标题 `**思考过程**` 只出现一次(正文夹多段思考不会重复刷小标题)。
- `final` 模式会把整段思考在正文**之前**发出去,不会跑到回答后面。
- 思考强度可用 `splash.thinkingLevels` 按完整模型 ID 单独设置,优先级高于 `splash.reasoningEffort`;
  布尔 `true` = 不下发参数(服务端默认),`false` = 下发 `none`。模型声明了 `efforts` 时,只有声明过的值
  和 `none` 会下发,其余在日志与诊断命令里说明忽略原因。

**工具调用**(`src/toolCalls.ts`)

- 上报前先清洗:工具名必须出现在本次 `options.tools` 里(大小写/下划线差异自动对齐);
  参数 JSON 被 `max_tokens` 截断时自动补全引号与括号;缺必需参数或完全重复的调用会被跳过。
- `splash.maxToolsPerRequest > 0` 时,工具数上限写进 `capabilities.toolCalling`,并在本地再截一次;
  VS Code 或第三方调用方忽略能力声明时也不会把上百个工具 schema 塞给本地模型。
- 不清洗的后果:VS Code 拿到残缺参数会在确认卡片/工具执行里抛
  `Cannot read properties of undefined (reading 'length')`,并留下永远 pending 的工具确认。
- 每条调用都写进 Output 面板 `Splash`:`↳ 工具 名字({…})`(必要时标注 `[参数被截断,已修复]`);
  被跳过的写 `✗ 跳过工具调用 名字: 原因 | 原始参数 …`,方便复盘模型到底返回了什么。

**超时与错误**(`src/timeouts.ts`、`src/client.ts`)

- 三段超时 + `SplashTimeoutError`;`fetch` 里靠 `signal.aborted` 判断中断,
  不再把 `TimeoutError` / undici 的 `TypeError: fetch failed` 误判成连接失败。
- 非流式的 `/v1/models`、`/tokenize` 走同一套超时,不会被 600s 卡死。
- **连接层失败会自动重试一次**(间隔 400 ms):`splash serve` 刚起来、端口刚监听时第一次连接
  常被拒,而那时请求根本没发出去,重试是安全的。只重试一次,不会重复生成。
- `/status` 只用来推导超时:有上次结果时改为后台刷新,不再让每条消息都等它。
- 截断提示只在 `max_tokens >= 256` 的真实生成里显示:VS Code 生成会话标题之类的小请求只有几十 token,
  同样会 `finish=length`,把提示写进去会被当成会话标题。

---

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 模型列表为空 / 状态栏 `Splash` 带斜杠 | splash 未启动或端口不对,执行 `Splash: 检查本地服务状态` |
| 中文界面里选不到模型 | 命令面板执行 `Splash: 刷新模型列表`;仍不行看 Output 面板 `Splash` 的报错 |
| 401 | Key 要和 `--api-key` 一致(splash 除 `/health`、`/ready` 外都要鉴权)。优先检查配置组的 `apiKey`,其次钥匙串,最后 `splash.apiKey`;超时提示里会直接点出是 401 而不是「服务没启动」 |
| 状态栏出现 `$(warning)` | 服务暂时连不上,显示的是上次成功加载的模型列表(不再被清空);恢复后图标自动变回 `$(cpu)` |
| 思考强度没生效 | 执行 `Splash: 诊断模型`,核对模型 ID 是否和 `splash.thinkingLevels` 的 key 完全一致、值是否被模型 `efforts` 支持;`none` 和布尔 `false` 会明确关闭思考 |
| 服务端报 `unknown field stream_options` | 不用管:400 且提到 `stream_options` 时会自动去掉它重试一次,代价是拿不到 usage |
| 气泡完全空白 | 模型什么都没返回时会补一句提示(带 `finish` 原因),不再让你对着空气猜;详情看 `Splash: 打开日志` |
| 服务刚启动时第一次请求报连接失败 | 已自动重试一次;仍失败说明端口没监听,执行 `Splash: 检查本地服务状态` |
| 服务在线但响应慢,却提示「无法连接 splash」 | 已修:connect/idle/total 三段超时各自独立,且超时后会探 `/health` 区分「在线但慢」和「真没启动」。见[超时策略](#超时策略) |
| 超时该由谁决定? | 默认全交给服务:三项都是 `0`,总时长不限制,由 `splash serve --request-timeout`(默认 `none` = 永不过期)决定;服务端到期返回 504,扩展原样报状态码 + 响应体(见 `npm run smoke:slow`) |
| 第一次请求特别慢 | splash 默认 `--idle-release 10m`,空闲 10 分钟后卸载权重,下次请求要重新加载;此时 connect 会推导成 180s。想让机器一直待命就 `splash serve --idle-release off` |
| 工具确认卡在 `N confirmations pending` | 开 Output 面板 `Splash` 看那轮返回了哪些调用。小模型常给空参数/未知工具名,把卡片渲染坏或让执行抛 `Cannot read properties of undefined (reading 'length')`,确认一直挂到会话中止;现在这类调用会被跳过并写明原因 |
| 会话标题变成 `_回复在 32 tokens 处被截断…_` | 那是 VS Code 的标题小请求(几十 token)被提示污染,已修;若仍异常,重载窗口后复现并贴 `Splash` 频道日志 |
| Agent 模式每轮 prompt 38k+ tokens、102 个工具 | 工具 schema 占大头,本地小模型容易被压垮。少开 MCP/工具,设 `splash.maxToolsPerRequest`(如 16)截断工具列表,或把 `splash.reasoningEffort` 设为 `low` 降低每轮耗时 |
