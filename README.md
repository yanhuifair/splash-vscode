# Splash for VS Code

[![VS Code 1.104+](https://img.shields.io/badge/VS%20Code-1.104%2B-007ACC?logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com/) ![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)

[English](README.en.md) · **中文**

把本地 `splash serve` 接入 VS Code 的聊天模型体系：模型选择器里出现 `Splash` 分组，其它扩展也能用 `vscode.lm.selectChatModels({ vendor: 'splash' })` 调用它。

仓库：[yanhuifair/splash-vscode](https://github.com/yanhuifair/splash-vscode)

## 特性

- 流式输出、思考内容（`reasoning_content`）、工具调用（function calling）。
- 图片输入（视觉模型）与 PDF 输入（模型支持视觉时）。
- 多配置组：不同组可连接不同的 `splash serve`，模型列表、缓存与密钥互不串组。
- API Key 由 VS Code 安全存储，或写入系统钥匙串，避免明文落在 `settings.json`。
- 状态栏实时显示服务与模型状态，配套诊断与管理命令。
- 三段独立超时，按 `/status` 推导；离线检查覆盖配置解析、工具调用、思考强度与慢服务。

> 前置条件：splash 已在本地运行；VS Code ≥ 1.104（Model Provider API 稳定版）。配置组需 1.127+；原生思考块在 1.147+ 自动探测。

## 目录

- [快速开始](#快速开始)
- [使用](#使用)
- [配置](#配置)
- [命令](#命令)
- [超时策略](#超时策略)
- [常见问题](#常见问题)
- [开发](#开发)
- [发布到 Microsoft Marketplace](#发布到-microsoft-marketplace)
- [许可证](#许可证)

## 快速开始

### 1. 启动 splash

```bash
splash serve --model unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M
# 默认监听 127.0.0.1:8000；换端口 --port 8001；需要鉴权 --api-key xxx
```

### 2. 安装扩展

编译 → 打包 `build/splash-model-provider.vsix` → 安装到当前 VS Code：

```bash
npm install
npm run install-ext
```

### 3. 重载并使用

命令面板执行 `Developer: Reload Window`，聊天面板里选 `Splash` 分组下的模型。
状态栏会显示 `Splash · <模型名>`，点它可以检查服务状态。

## 使用

### 模型选择

1. 模型选择器里选 `Splash` 分组下的模型；看不到就先执行 `Splash: 刷新模型列表`。
   同一个模型的量化档和上下文放在名字右侧（`Qwen3.8-27B · Q4_K_M · 32k`），不用展开 tooltip 就能区分。
2. Agent / 工具模式下模型被标记为支持工具调用，VS Code 会把工具列表一并发给 splash
   （不想要就关 `splash.enableTools`）。

### 思考内容（reasoning_content）

- 默认**不显示**（`splash.reasoningMode: off`）。思考内容即使以原生块呈现也会参与生成；
  `stream` / `final` 在旧版 VS Code 里只能当正文文本留在会话历史，下一轮再发给模型，白烧上下文。
  本地模型上下文本来就紧，所以默认关掉。
- 想看就切 `stream`（实时流式）或 `final`（结尾一次性显示）。VS Code 1.147+ 会自动使用原生可折叠思考块，
  旧版退化为 Markdown 引用块，且 `**思考过程**` 标题只出现一次。
- `final` 模式把整段思考放在正文**之前**，不会跑到回答后面。
- 按模型覆盖强度用 `splash.thinkingLevels`，见[设置项](#设置项)。

### 图片与 PDF

- 视觉模型可直接接收图片；PDF 以 data URL 的 `file` part 发给 splash，由模型支持视觉时识别。
- 工具结果里附带的图片 / PDF 会紧跟一条 `user` 消息带上去，不会因为 `role: "tool"` 只收字符串而丢失。

### 状态栏

请求期间变成 `$(sync~spin) Splash · 等待响应` / `生成中`：本地模型首字慢时，
能立刻分清「在加载权重」还是「扩展没反应」。失败则显示 `$(error) Splash · 请求失败` 十秒，
点一下直接查服务状态。生成结束回到当前模型名（最近真正用过的那个）。

## 配置

### API Key 优先级

配置组的 `apiKey` > 系统钥匙串（`Splash: 设置 API Key`）> `splash.apiKey` 明文设置。
明文设置会随 Settings Sync 同步，建议优先用前两种。

### 配置组（推荐）

VS Code 1.127+ 可在「管理模型」里为 Splash 添加任意多个配置组，分别连接不同的 `splash serve`：

1. 聊天模型选择器 → 齿轮 → **Manage Language Models** → Add Models → 选 **Splash**。
2. 填写组名，并在配置里设置：

| 字段 | 作用 |
| --- | --- |
| `url` | 该组的 splash 地址，优先于 `splash.baseUrl` |
| `models` | 完整模型 ID 白名单；留空则使用服务返回的全部模型 |
| `headers` | 模型发现与聊天请求都带上的自定义 header（反代 / 网关鉴权） |
| `apiKey` | 对应 `--api-key`，由 VS Code 安全存储，优先于钥匙串和 `splash.apiKey` |

每组的模型列表、超时推导、token 缓存和 `/tokenize` 冷却都是**独立**的；请求会回到该模型所属的地址和密钥，不会串组。
`Splash: 管理 Splash 模型` 命令（齿轮入口）保留作旧版本兼容。

### 设置项

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `splash.baseUrl` | `http://127.0.0.1:8000` | 对应 `splash serve --host/--port`；末尾的 `/v1` 会被自动去掉 |
| `splash.apiKey` | `""` | 对应 `splash serve --api-key`。明文设置，建议改用钥匙串命令或配置组的 `apiKey` |
| `splash.headers` | `{}` | 所有请求附带的自定义 HTTP header；配置组里的 `headers` 优先 |
| `splash.modelFilter` | `""` | 逗号分隔关键词，只保留模型 ID 命中的模型 |
| `splash.maxOutputTokens` | `8192` | 单次回复上限，同时从上下文里预留 |
| `splash.temperature` | `null` | `null` = 用服务端默认值 |
| `splash.reasoningEffort` | `server` | `none` / `minimal` / `low` / `medium` / `high` / `xhigh`；`server` = 不下发该参数 |
| `splash.thinkingLevels` | `{}` | 按完整模型 ID 覆盖思考强度；`true` = 服务端默认、`false` = 关闭思考。优先级高于全局设置，低于调用方显式参数 |
| `splash.reasoningMode` | `off` | 思考内容显示方式：`off` 不显示（默认） / `stream` 实时流式 / `final` 结尾一次性。见[思考内容](#思考内容reasoning_content) |
| `splash.serverTokenizer` | `true` | 用 splash `/tokenize` 精确统计 token（否则按字符估算） |
| `splash.enableTools` | `true` | 是否声明支持工具调用。小模型在 Agent 模式被上百个工具压垮时，关掉它比调超时更有效 |
| `splash.maxToolsPerRequest` | `0` = 不限制 | 单请求最多下发多少个工具。`>0` 时同时写入模型能力声明并在本地截断工具列表 |
| `splash.connectTimeoutMs` | `0` = 跟随服务 | 等服务端开始应答（响应头），详见[超时策略](#超时策略) |
| `splash.idleTimeoutMs` | `0` = 跟随服务 | 流式回复相邻两块数据的最大间隔，详见[超时策略](#超时策略) |
| `splash.requestTimeoutMs` | `0` = 不限制 | 总上限交给 `splash serve --request-timeout` |
| `splash.showStatusBar` | `true` | 状态栏指示器 |

## 命令

| 命令 | 作用 |
| --- | --- |
| `Splash: 刷新模型列表` | 重新读 `/v1/models`，刷新聊天模型选择器 |
| `Splash: 检查本地服务状态` | 探测 `/health` 与模型列表，结果输出到提示和 Output 面板 `Splash` 频道 |
| `Splash: 设置 API Key(存系统钥匙串)` | 把 `--api-key` 写进系统钥匙串，不再明文落在 `settings.json`（留空回车即清除） |
| `Splash: 管理 Splash 模型` | 统一入口：检查服务 / 诊断模型 / 设置 Key / 刷新模型 / 日志 / 设置。也出现在模型选择器的齿轮菜单里 |
| `Splash: 诊断模型` | 输出配置来源、VS Code 模型列表、直接 `/health` + `/v1/models` 探测结果和思考强度策略到 `Splash` 频道 |
| `Splash: 打开日志` | 打开 Output 面板 `Splash` 频道（排查看这里最快） |

## 超时策略

一次请求的超时被拆成三段，三项设置的语义一致：**`0` = 跟随服务（默认）、`-1` = 关闭该项、`>0` = 手动固定毫秒数**。
推导逻辑在 `src/timeouts.ts`，输入是 splash `/status` 的实时状态：

| 段 | 含义 | 跟随服务时怎么算 |
| --- | --- | --- |
| `connect` | 服务端开始应答（响应头） | 就绪 30s；`weights.released/restoring` 180s；每个排队请求（admission.waiting + scheduler.queued）+15s；上限 15min |
| `idle` | 流式回复相邻两块数据的间隔 | 取历史请求平均耗时 `latency.http_request` 的 5 倍，限 5–30 分钟 |
| `total` | 整条请求上限 | 不限制，交给 `splash serve --request-timeout`；服务端到期返回 504，扩展原样报状态码 + 响应体 |

- 拿不到 `/status` 时用兜底值：connect 120s、idle 600s。
- 推导结果打在 Output 面板 `Splash`：`超时 connect=… idle=… total=…`，可核对是否符合预期。
- 想改行为优先调 splash 参数（`--idle-release`、`--request-timeout`、`--queue-size`），而不是在 VS Code 里填数字。
- 超时后扩展会顺带探一次 `/health`，明确区分「在线但慢 / 正在加载模型」和「真的没启动」。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 模型列表为空 / 状态栏 `Splash` 带斜杠 | splash 未启动或端口不对，执行 `Splash: 检查本地服务状态` |
| 中文界面里选不到模型 | 命令面板执行 `Splash: 刷新模型列表`；仍不行看 Output 面板 `Splash` 的报错 |
| 401 | Key 要和 `--api-key` 一致（splash 除 `/health`、`/ready` 外都要鉴权）。优先检查配置组的 `apiKey`，其次钥匙串，最后 `splash.apiKey`；超时提示里会直接点出是 401 而不是「服务没启动」 |
| 状态栏出现 `$(warning)` | 服务暂时连不上，显示的是上次成功加载的模型列表（不再被清空）；恢复后图标自动变回 `$(cpu)` |
| 思考强度没生效 | 执行 `Splash: 诊断模型`，核对模型 ID 是否和 `splash.thinkingLevels` 的 key 完全一致、值是否被模型 `efforts` 支持；`none` 和布尔 `false` 会明确关闭思考 |
| 服务端报 `unknown field stream_options` | 不用管：400 且提到 `stream_options` 时会自动去掉它重试；与连接重试叠加时最多发 3 次请求，代价是拿不到 usage |
| 气泡完全空白 | 模型什么都没返回时会补一句提示（带 `finish` 原因），不再让你对着空气猜；详情看 `Splash: 打开日志` |
| 服务刚启动时第一次请求报连接失败 | 已自动重试一次（间隔 400ms，请求没发出去时重试是安全的）；仍失败说明端口没监听，执行 `Splash: 检查本地服务状态` |
| 服务在线但响应慢，却提示「无法连接 splash」 | 三段超时各自独立，且超时后会探 `/health` 区分「在线但慢」和「真没启动」。见[超时策略](#超时策略) |
| 超时该由谁决定？ | 默认全交给服务：三项都是 `0`，总时长不限制，由 `splash serve --request-timeout`（默认 `none` = 永不过期）决定；服务端到期返回 504，扩展原样报状态码 + 响应体（见 `npm run smoke:slow`） |
| 第一次请求特别慢 | splash 默认 `--idle-release 10m`，空闲 10 分钟后卸载权重，下次请求要重新加载；此时 connect 会推导成 180s。想让机器一直待命就 `splash serve --idle-release off` |
| 工具确认卡在 `N confirmations pending` | 开 Output 面板 `Splash` 看那轮返回了哪些调用。小模型常给空参数 / 未知工具名，把卡片渲染坏或让执行抛 `Cannot read properties of undefined (reading 'length')`，确认一直挂到会话中止；现在这类调用会被跳过并写明原因 |
| 会话标题变成 `_回复在 32 tokens 处被截断…_` | 那是 VS Code 的标题小请求（几十 token）被提示污染，已修；若仍异常，重载窗口后复现并贴 `Splash` 频道日志 |
| Agent 模式每轮 prompt 38k+ tokens、102 个工具 | 工具 schema 占大头，本地小模型容易被压垮。少开 MCP / 工具，设 `splash.maxToolsPerRequest`（如 16）截断工具列表，或把 `splash.reasoningEffort` 设为 `low` 降低每轮耗时 |

## 开发

### 日常开发

```bash
npm run dev
# 监视 src/**/*.ts 与 package.json：保存 → tsc 编译 → vsce 打包 → 安装到当前 VS Code
```

每次装完仍需重载扩展主机（`Developer: Reload Window`）。建议绑个快捷键，`keybindings.json`：

```jsonc
{ "key": "ctrl+cmd+r", "command": "workbench.action.reloadWindow" }
```

改完代码提交前跑 `npm run verify`（eslint + 编译 + 全部离线检查），比装完再去聊天里试快得多。

其它提示：

- 只验证单处改动时，按 F5 起 Extension Development Host 更快（改完 `Cmd+R` 重载，不必打包安装）。
- 用 Insiders / Cursor，或 PATH 里没有 `code`：执行 `Shell Command: Install 'code' command in PATH`，
  或设 `CODE_CLI` 指向本机 VS Code 可执行文件。`install.js` 也会自动探测常见安装位置。
- 打包产物统一在 `build/`（已 gitignore），根目录不散落 vsix。

### 自测

纯函数 / 本地假服务器的检查不联网，可随时跑；真实链路冒烟需要 splash 在跑。

```bash
npm run verify   # eslint + 编译 + 全部离线检查，提交前跑这一条
npm test         # 只跑编译 + 离线检查
npm run lint     # 只跑 eslint
```

| 命令 | 覆盖内容 | 需要 splash |
| --- | --- | --- |
| `npm run smoke` | 真实链路：health / models / tokenize / 流式 / 思考 / 工具调用 / 视觉 / PDF | 是 |
| `npm run smoke:openai` | 消息转换：图片 / PDF（data part）、工具结果、token 估算、模型显示名（纯函数） | 否 |
| `npm test` 内置检查 | Provider 配置组解析、secret 声明、组隔离 key、自定义 header、按模型思考强度优先级 | 否 |
| `npm run smoke:tools` | 工具调用清洗 + 参数修复耗时（纯函数） | 否 |
| `npm run smoke:slow` | 慢服务、错误分类、SSE 心跳、`stream_options` 与连接重置重试（本地假服务器） | 否 |
| `npm run smoke:timeouts` | 超时推导（纯函数） | 否 |

冒烟测试可换地址：

```bash
SPLASH_BASE_URL=http://127.0.0.1:8001 SPLASH_API_KEY=xxx npm run smoke
```

### 实现要点

#### 接入方式

- 贡献点 `languageModelChatProviders`（`vendor: splash`）+ `vscode.lm.registerLanguageModelChatProvider`，
  即 VS Code 1.104+ 的稳定 Model Provider API；`engines.vscode` 锁 `^1.104.0`。
  `onStartupFinished` 让扩展在窗口启动后即可激活，状态栏和模型列表更早可用。
- 1.127+ 的 provider `configuration`（`options.configuration`）支持多个配置组；每组独立缓存地址、白名单、
  header、密钥、超时与 token 数，`secret: true` 的 `apiKey` 只参与组 key 哈希，不会写进日志。
- 模型元数据来自 `/v1/models` 的 `context_length`、`vision`、`input_modalities`、`reasoning.efforts`，
  用于填 VS Code 的 `maxInputTokens` / `capabilities`。
- 图标为 `images/icon.png`，由 `AppIcon.icns` 导出；provider 图标用
  `languageModelChatProviders[].icon` 的 `{ light, dark }` 形式指向同一张图。

#### 思考内容的实现

- `resolveThinkingLevel` 的优先级：调用方 `modelOptions` > `splash.thinkingLevels[完整模型 ID]` >
  `splash.reasoningEffort`。`server` / `true` 不下发参数，`none` / `false` 明确关闭思考。
- 模型声明 `efforts` 时，只接受声明过的值和 `none`；其余在日志与诊断命令里说明忽略原因。
- 1.147+ 自动探测 `LanguageModelThinkingPart`（未在公开 d.ts 中声明）并使用原生思考块；
  老版本退化为 Markdown，标题不重复。

#### 图片、PDF 与 token 估算

- `LanguageModelChatRequestMessage` → OpenAI 消息：工具结果转 `role: "tool"`，图片转 `image_url` 的 data URL，
  PDF（`application/pdf` 的 `LanguageModelDataPart`）转 splash 的 `{"type":"file"}` part。
- 图片 part 的 MIME 取自 `LanguageModelDataPart.mimeType`；认不出的二进制只留
  `[application/pdf 数据, N 字节]` 占位，不会把字节当文本塞进提示词。
- `provideTokenCount` 按 part 分别估算：工具结果、工具调用参数都计入；图片按 850 token / 张，
  PDF 按 850 token / 页（最多按 64 页估）；含媒体的消息跳过 `/tokenize`，避免把媒体算成 0。
  纯文本里 CJK 按 0.75 token / 字，其余按 4 字符 / token。结果用文本哈希缓存，
  `/tokenize` 失败后 60 秒内直接用估算。

#### 工具调用

- 上报前先清洗：工具名必须出现在本次 `options.tools` 里（大小写 / 下划线差异自动对齐）；
  参数 JSON 被 `max_tokens` 截断时自动补全引号与括号；缺必需参数或完全重复的调用会被跳过。
- `splash.maxToolsPerRequest > 0` 时，工具数上限写进 `capabilities.toolCalling`，并在本地再截一次；
  VS Code 或第三方调用方忽略能力声明时也不会把上百个工具 schema 塞给本地模型。
- 不清洗的后果：VS Code 拿到残缺参数会在确认卡片 / 工具执行里抛
  `Cannot read properties of undefined (reading 'length')`，并留下永远 pending 的工具确认。
- 每条调用都写进 Output 面板 `Splash`：`↳ 工具 名字({…})`（必要时标注 `[参数被截断,已修复]`）；
  被跳过的写 `✗ 跳过工具调用 名字: 原因 | 原始参数 …`，方便复盘模型到底返回了什么。

#### 超时与错误

- 三段超时 + `SplashTimeoutError`；`fetch` 里靠 `signal.aborted` 判断中断，
  不再把 `TimeoutError` / undici 的 `TypeError: fetch failed` 误判成连接失败。
- 非流式的 `/v1/models`、`/tokenize` 走同一套超时，不会被 600s 卡死。
- **连接层失败自动重试一次**（间隔 400ms，请求没发出去时安全）；400 且提到 `stream_options` 时
  去掉该字段重试。两者统一为最多 3 次请求，可叠加：连接重试后的第二次仍可能因
  `stream_options` 被 400 拒绝并再降级。重试都发生在响应正文之前，不会重复生成。
- `/status` 只用来推导超时：有上次结果时改为后台刷新，不再让每条消息都等它。
- 截断提示只在 `max_tokens >= 256` 的真实生成里显示：VS Code 生成会话标题之类的小请求只有几十 token，
  同样会 `finish=length`，把提示写进去会被当成会话标题。

## 发布到 Microsoft Marketplace

VS Code 商店发布使用 `vsce`。推荐用 GitHub Actions + Trusted Publishing（OIDC），不再保存长期 PAT；Azure DevOps 全局 PAT 会在 2026-12-01 退役。

首次准备：

1. 在 Visual Studio Marketplace 管理页创建 publisher。ID 建议用 `yanhuifair`，创建后不可修改。
2. 在该 publisher 的 **Trusted Publishing** 中添加策略：
   - Repository owner：`yanhuifair`
   - Repository：`splash-vscode`
   - Workflow：`publish.yml`
   - Environment：留空
3. 在 GitHub 仓库 **Settings → Secrets and variables → Actions → Variables** 添加 `VSCE_PUBLISHER=<publisher ID>`。
4. 本地 `package.json` 保持 `publisher: local`。CI 的优先级是手动输入 `publisher` > `VSCE_PUBLISHER` > 默认 `yanhuifair`，避免开发版和商店版 ID 混用。

发布方式：

```bash
git tag v0.7.0
git push origin v0.7.0
```

或在 Actions 手动运行 **Publish VS Code Extension**。勾选 `dry_run` 只打包并上传 VSIX，不发布商店。

如果 OIDC 返回 `The requested publisher doesn't exist`，先确认 publisher 已在 Marketplace 创建并验证，且 Trusted Publishing policy 已创建。临时发布可先在 GitHub Actions Secrets 添加 `VSCE_PAT`（Azure DevOps `Marketplace` 的 `Manage` scope）；工作流会优先使用 `VSCE_PAT`，没有该 secret 时才使用 OIDC。

## 许可证

MIT
