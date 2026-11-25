# Splash for VS Code

[![VS Code 1.104+](https://img.shields.io/badge/VS%20Code-1.104%2B-007ACC?logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com/) ![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)

**English** · [简体中文](README.md)

Connect a local `splash serve` to VS Code's chat model system: a `Splash` group appears in the model picker, and other extensions can call it through `vscode.lm.selectChatModels({ vendor: 'splash' })`.

Repository: [yanhuifair/splash-vscode](https://github.com/yanhuifair/splash-vscode)

## Features

- Streaming output, reasoning content (`reasoning_content`), and function calling.
- Image input for vision models and PDF input when the model supports vision.
- Multiple configuration groups: each group can connect to a different `splash serve`, with independent model lists, caches, and secrets.
- API keys can be stored securely in VS Code Secret Storage or the system keychain instead of plain `settings.json`.
- Status bar shows service and model state in real time, with diagnostic and management commands.
- Three independent timeout segments inferred from `/status`; offline checks cover config parsing, tool calls, thinking levels, and slow services.

> Prerequisites: splash is running locally; VS Code >= 1.104 (stable Model Provider API). Provider configuration groups require VS Code 1.127+; native thinking blocks are auto-detected on VS Code 1.147+.

## Table of Contents

- [Quick Start](#quick-start)
- [Usage](#usage)
- [Configuration](#configuration)
- [Commands](#commands)
- [Timeout Policy](#timeout-policy)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Publish to the VS Code Marketplace](#publish-to-the-vs-code-marketplace)
- [License](#license)

## Quick Start

### 1. Start splash

```bash
splash serve --model unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M
# Listens on 127.0.0.1:8000 by default; use --port 8001 to change the port; use --api-key xxx for auth
```

### 2. Install the extension

Compile, package `build/splash-model-provider.vsix`, then install it into the current VS Code:

```bash
npm install
npm run install-ext
```

### 3. Reload and use

Run `Developer: Reload Window` from the Command Palette, then pick a model under the `Splash` group in the chat panel.
The status bar shows `Splash · <model>`; click it to check the server status.

## Usage

### Model Selection

1. Pick a model under the `Splash` group in the model picker. If none appears, run `Splash: 刷新模型列表` (`splash.refreshModels`).
   Quantization and context are shown to the right of the model name (`Qwen3.8-27B · Q4_K_M · 32k`), so you can tell them apart without opening the tooltip.
2. In Agent / tool mode the model advertises tool calling, so VS Code sends the tool list to splash.
   Disable this with `splash.enableTools` if you do not want it.

### Thinking content (`reasoning_content`)

- Hidden by default (`splash.reasoningMode: off`). Thinking still consumes output budget and may be kept in session history.
  On older VS Code versions it can only be emitted as ordinary assistant text and sent back to the model on the next turn, wasting context.
  Local models often have tight context budgets, so the default is off.
- To view thinking, choose `stream` for live streaming or `final` for a single block at the end. VS Code 1.147+ uses the native collapsible thinking block;
  older versions fall back to a Markdown blockquote with a single `**思考过程**` heading.
- `final` emits the thinking block before the answer, not after it.
- Use `splash.thinkingLevels` to override the level for a full model ID. See [Settings](#settings).

### Images and PDF

- Vision models can receive images directly. PDFs are sent to splash as a `file` part with a data URL when the model supports vision.
- Images or PDFs attached to tool results are sent as a following `user` message, because OpenAI `role: "tool"` only accepts string content.

### Status Bar

During a request the status item becomes `$(sync~spin) Splash · 等待响应` or `生成中`. When local models are slow to produce the first token,
this makes it clear whether weights are loading or the extension is not responding. On failure it shows `$(error) Splash · 请求失败` for ten seconds;
click it to check the server status. After generation finishes, it returns to the current model name, which is the model most recently used.

## Configuration

### API Key Priority

Provider group `apiKey` > system keychain (`Splash: 设置 API Key(存系统钥匙串)`) > plain `splash.apiKey` setting.
Plain settings can be included in Settings Sync, so prefer the first two options.

### Provider Configuration Groups (Recommended)

VS Code 1.127+ can add any number of Splash provider configuration groups in **Manage Language Models**, each connecting to a different `splash serve`:

1. Chat model picker → gear icon → **Manage Language Models** → Add Models → choose **Splash**.
2. Enter a group name and set:

| Field | Purpose |
| --- | --- |
| `url` | Splash URL for this group; takes precedence over `splash.baseUrl` |
| `models` | Whitelist of full model IDs; leave empty to use all models returned by the server |
| `headers` | Custom headers sent with model discovery and chat requests, useful for reverse proxies or gateways |
| `apiKey` | Corresponds to `--api-key`; stored securely by VS Code and takes precedence over the keychain and `splash.apiKey` |

Each group has independent model lists, timeout inference, token caches, and `/tokenize` cooldowns. Requests go back to the address and secret belonging to that model's group.
The `Splash: 管理 Splash 模型` command remains available as the gear-menu compatibility path for older VS Code versions.

### Settings

| Setting | Default | Description |
| --- | --- | --- |
| `splash.baseUrl` | `http://127.0.0.1:8000` | Corresponds to `splash serve --host/--port`; a trailing `/v1` is stripped automatically |
| `splash.apiKey` | `""` | Corresponds to `splash serve --api-key`. Plain setting; prefer the keychain command or a provider group `apiKey` |
| `splash.headers` | `{}` | Custom HTTP headers added to all requests; group-level `headers` take precedence |
| `splash.modelFilter` | `""` | Comma-separated keywords; keeps only models whose ID contains one of them |
| `splash.maxOutputTokens` | `8192` | Maximum response tokens, also reserved from the context window |
| `splash.temperature` | `null` | `null` = use the server default |
| `splash.reasoningEffort` | `server` | `none` / `minimal` / `low` / `medium` / `high` / `xhigh`; `server` = do not send the parameter |
| `splash.thinkingLevels` | `{}` | Per full model ID thinking-level override; `true` = server default, `false` = disable thinking. Higher priority than the global setting, lower than explicit caller options |
| `splash.reasoningMode` | `off` | Thinking display mode: `off` = hidden, default / `stream` = live / `final` = once at the end. See [Thinking content](#thinking-content-reasoning_content) |
| `splash.serverTokenizer` | `true` | Use splash `/tokenize` for exact token counts; otherwise estimate by character count |
| `splash.enableTools` | `true` | Whether to advertise tool calling. When small models are overwhelmed by hundreds of tools in Agent mode, turning this off is often more effective than tuning timeouts |
| `splash.maxToolsPerRequest` | `0` = unlimited | Maximum number of tools sent per request. When `> 0`, the limit is written into the model capability and the tool list is also truncated locally |
| `splash.connectTimeoutMs` | `0` = follow server | Wait for the server to start answering, i.e. response headers. See [Timeout Policy](#timeout-policy) |
| `splash.idleTimeoutMs` | `0` = follow server | Maximum interval between adjacent streaming chunks. See [Timeout Policy](#timeout-policy) |
| `splash.requestTimeoutMs` | `0` = unlimited | Total limit is delegated to `splash serve --request-timeout` |
| `splash.showStatusBar` | `true` | Status bar indicator |

## Commands

| Command | Purpose |
| --- | --- |
| `Splash: 刷新模型列表` (`splash.refreshModels`) | Reload `/v1/models` and refresh the chat model picker |
| `Splash: 检查本地服务状态` (`splash.checkServer`) | Probe `/health` and the model list; output goes to notifications and the `Splash` Output panel |
| `Splash: 设置 API Key(存系统钥匙串)` (`splash.setApiKey`) | Write the `--api-key` value into the system keychain so it no longer lives in plain `settings.json`; submit an empty value to clear it |
| `Splash: 管理 Splash 模型` (`splash.manage`) | Unified entry point: check server, diagnose models, set key, refresh models, logs, settings. Also appears in the model picker gear menu |
| `Splash: 诊断模型` (`splash.diagnoseModels`) | Print config source, VS Code model list, direct `/health` and `/v1/models` probes, and the thinking-level policy to the `Splash` channel |
| `Splash: 打开日志` (`splash.openLog`) | Open the `Splash` channel in the Output panel, usually the fastest place to debug |

## Timeout Policy

Each request is split into three timeout segments, with consistent semantics: **`0` = follow server, default; `-1` = disable that segment; `> 0` = manual milliseconds**.
The inference logic lives in `src/timeouts.ts` and uses live data from splash `/status`:

| Segment | Meaning | Follow-server behavior |
| --- | --- | --- |
| `connect` | Server starts answering, i.e. response headers | 30s when ready; 180s during `weights.released/restoring`; +15s per queued request (`admission.waiting + scheduler.queued`); cap 15min |
| `idle` | Maximum interval between adjacent streaming chunks | 5x historical average `latency.http_request`, bounded to 5-30 minutes |
| `total` | Whole request limit | Unlimited by default, delegated to `splash serve --request-timeout`; when the server returns 504, the extension surfaces the status code and body |

- If `/status` is unavailable, fallbacks are used: connect 120s, idle 600s.
- Inferred values are printed to the `Splash` Output panel: `超时 connect=… idle=… total=…`.
- Prefer tuning splash server flags (`--idle-release`, `--request-timeout`, `--queue-size`) over entering numbers in VS Code.
- After a timeout, the extension probes `/health` once to distinguish "online but slow / weights loading" from "not started".

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| Model list is empty or the `Splash` status item has a slash | splash is not running or the port is wrong; run `Splash: 检查本地服务状态` |
| Models do not appear in a Chinese UI | Run `Splash: 刷新模型列表` from the Command Palette; if it still fails, check the `Splash` Output panel for errors |
| 401 | The key must match `--api-key`; splash protects every endpoint except `/health` and `/ready`. Check provider group `apiKey` first, then the keychain, then `splash.apiKey`; timeout messages now point out 401 instead of saying "server not started" |
| The status bar shows `$(warning)` | The server is temporarily unreachable. The extension keeps the last successfully loaded model list instead of clearing it; the icon returns to `$(cpu)` after recovery |
| Thinking level does not take effect | Run `Splash: 诊断模型` and verify the model ID matches the `splash.thinkingLevels` key exactly and the value is supported by the model's `efforts`; `none` and boolean `false` explicitly disable thinking |
| Server reports `unknown field stream_options` | Usually harmless. On 400 errors mentioning `stream_options`, the extension retries without that field; combined with connection retry it can send up to 3 requests, and usage data is unavailable in that mode |
| Chat bubble is completely empty | If the model returns nothing, the extension adds a short message with the `finish` reason instead of leaving an empty bubble. Use `Splash: 打开日志` for details |
| First request fails right after starting the server | Connection-level failures are retried once after 400ms. Retrying is safe because the request had not been sent. If it still fails, the port is probably not listening; run `Splash: 检查本地服务状态` |
| Server is online but slow, yet the extension says it cannot connect | The three timeout segments are independent, and timeout handling now probes `/health` to distinguish "online but slow" from "not started". See [Timeout Policy](#timeout-policy) |
| Who should decide request timeouts? | By default the server decides: all three settings are `0`, total duration is unlimited, and `splash serve --request-timeout` (`none` by default, meaning no expiry) controls the final result. Server-side expiry returns 504 and the extension surfaces the status code plus body; see `npm run smoke:slow` |
| First request is very slow | splash defaults to `--idle-release 10m`, unloads weights after 10 idle minutes, and reloads them on the next request. Connect timeout then infers to 180s. To keep weights resident, run `splash serve --idle-release off` |
| Tool confirmation stays stuck at `N confirmations pending` | Open the `Splash` Output panel and inspect what the model returned. Small models often emit empty arguments or unknown tool names, which can break the card or throw `Cannot read properties of undefined (reading 'length')`; such calls are now skipped with an explicit reason |
| Chat title becomes `_回复在 32 tokens 处被截断…_` | That was a VS Code title request (dozens of tokens) polluted by truncation notice. Fixed; if it still happens, reload the window, reproduce, and paste the `Splash` channel log |
| Agent mode sends 38k+ tokens and 102 tools per turn | Tool schemas dominate and can overwhelm small local models. Disable unused MCP / tools, set `splash.maxToolsPerRequest` (for example 16), or set `splash.reasoningEffort` to `low` to reduce time per turn |

## Development

### Daily Development

```bash
npm run dev
# Watches src/**/*.ts and package.json: save -> tsc compile -> vsce package -> install into current VS Code
```

After each install, reload the extension host (`Developer: Reload Window`). A keybinding helps:

```jsonc
{ "key": "ctrl+cmd+r", "command": "workbench.action.reloadWindow" }
```

Before committing, run `npm run verify` (eslint + compile + offline checks). It is much faster than installing the extension and trying it in chat.

Other tips:

- For a single change, press F5 to start the Extension Development Host. Reload with `Cmd+R` without packaging and installing.
- If `code` is not on PATH, or you use Insiders / Cursor, run `Shell Command: Install 'code' command in PATH` or set `CODE_CLI` to your VS Code executable. `install.js` also auto-detects common install locations.
- Packages are written to `build/` and ignored by git, so the repository root stays clean.

### Self Checks

Pure-function and local fake-server checks do not require a running splash service. Real smoke tests do.

```bash
npm run verify   # eslint + compile + all offline checks; run this before committing
npm test         # compile + offline checks only
npm run lint     # eslint only
```

| Command | Coverage | Requires splash |
| --- | --- | --- |
| `npm run smoke` | Real path: health / models / tokenize / streaming / thinking / tool calls / vision / PDF | Yes |
| `npm run smoke:openai` | Message conversion: image / PDF data parts, tool results, token estimation, model display names | No |
| Built into `npm test` | Provider group parsing, secret declaration, group-isolated keys, custom headers, thinking-level priority | No |
| `npm run smoke:tools` | Tool-call sanitization and argument repair timing | No |
| `npm run smoke:slow` | Slow servers, error classification, SSE heartbeats, `stream_options` and connection-reset retries | No |
| `npm run smoke:timeouts` | Timeout inference | No |

Smoke tests can point at another URL:

```bash
SPLASH_BASE_URL=http://127.0.0.1:8001 SPLASH_API_KEY=xxx npm run smoke
```

### Implementation Notes

#### Provider Wiring

- The extension contributes `languageModelChatProviders` (`vendor: splash`) and calls `vscode.lm.registerLanguageModelChatProvider`,
  the stable Model Provider API introduced in VS Code 1.104. `engines.vscode` is pinned to `^1.104.0`.
  `onStartupFinished` activates the extension after window startup so the status bar and model list appear earlier.
- VS Code 1.127+ provider `configuration` (`options.configuration`) supports multiple groups. Each group caches address, whitelist,
  headers, secrets, timeouts, and token counts independently. The `secret: true` `apiKey` participates only in the group-key hash and is never logged.
- Model metadata comes from `/v1/models`: `context_length`, `vision`, `input_modalities`, and `reasoning.efforts`,
  which are mapped to VS Code's `maxInputTokens` and `capabilities`.
- The icon is `images/icon.png`, exported from `AppIcon.icns`. The provider icon uses
  `languageModelChatProviders[].icon` in `{ light, dark }` form pointing to the same image.

#### Thinking Implementation

- `resolveThinkingLevel` priority: caller `modelOptions` > `splash.thinkingLevels[full model ID]` >
  `splash.reasoningEffort`. `server` / `true` does not send the parameter; `none` / `false` explicitly disables thinking.
- If a model declares `efforts`, only declared values and `none` are sent. Unsupported values are ignored with a reason in logs and diagnostics.
- VS Code 1.147+ auto-detects `LanguageModelThinkingPart` (not declared in the public d.ts) and uses native thinking blocks;
  older versions fall back to Markdown without repeating the heading.

#### Images, PDF, and Token Estimation

- `LanguageModelChatRequestMessage` is converted to OpenAI messages: tool results become `role: "tool"`, images become `image_url` data URLs,
  and PDFs from `application/pdf` `LanguageModelDataPart` values become splash `{"type":"file"}` parts.
- Image MIME types come from `LanguageModelDataPart.mimeType`. Unrecognized binary data becomes a placeholder such as
  `[application/pdf 数据, N 字节]` instead of being inserted as text.
- `provideTokenCount` estimates by part. Tool results and tool-call arguments are counted. Images are estimated at 850 tokens each,
  PDFs at 850 tokens per page up to 64 pages. Messages containing media skip `/tokenize` to avoid counting media as zero.
  Plain text estimates CJK at 0.75 tokens per character and other text at 4 characters per token. Results are cached by text hash,
  and after `/tokenize` fails the estimate is used for 60 seconds.

#### Tool Calls

- Tool calls are sanitized before being reported. Tool names must appear in the current `options.tools`;
  case and underscore differences are aligned automatically. JSON arguments truncated by `max_tokens` are repaired by closing quotes and braces;
  calls missing required fields or exactly duplicated are skipped.
- When `splash.maxToolsPerRequest > 0`, the limit is written into `capabilities.toolCalling` and the list is also truncated locally.
  This protects local models even when VS Code or third-party callers ignore the capability declaration.
- Without sanitization, VS Code can receive malformed arguments, throw
  `Cannot read properties of undefined (reading 'length')` in confirmation cards or tool execution, and leave tool confirmations pending forever.
- Every call is logged to the `Splash` Output panel: `↳ 工具 name({…})`, with `[参数被截断,已修复]` when needed.
  Skipped calls are logged as `✗ 跳过工具调用 name: reason | raw arguments …`, making it easy to inspect what the model returned.

#### Timeouts and Errors

- Three timeout segments plus `SplashTimeoutError`; inside `fetch`, `signal.aborted` determines interruption kind,
  avoiding false positives from `TimeoutError` or undici's `TypeError: fetch failed`.
- Non-streaming `/v1/models` and `/tokenize` requests share the same timeout logic and are not stuck on a 600s default.
- Connection-layer failures are retried once after 400ms when the request has not been sent. On 400 errors mentioning `stream_options`,
  the field is removed and the request retried. Both paths are unified into at most 3 requests and can stack: after a connection retry,
  the second request may still receive a `stream_options` 400 and downgrade. All retries happen before response body delivery, so generation is not duplicated.
- `/status` is used only for timeout inference. If a previous result exists, it is refreshed in the background instead of blocking every message.
- Truncation notices are shown only for real generations with `max_tokens >= 256`. VS Code title requests use a few dozen tokens and also return
  `finish=length`; adding the notice there can pollute the chat title.

## Publish to the VS Code Marketplace

Publishing uses `vsce`. The recommended path is GitHub Actions with Trusted Publishing (OIDC), so no long-lived Personal Access Token needs to be stored. Global Azure DevOps PATs are retired on December 1, 2026.

First-time setup:

1. Create a publisher on the Visual Studio Marketplace management page. The ID `yanhuifair` is a reasonable choice; it cannot be changed after creation.
2. Add a **Trusted Publishing** policy to that publisher:
   - Repository owner: `yanhuifair`
   - Repository: `splash-vscode`
   - Workflow: `publish.yml`
   - Environment: empty
3. In GitHub repository **Settings → Secrets and variables → Actions → Variables**, add `VSCE_PUBLISHER=<publisher ID>`.
4. Keep `package.json` at `publisher: local` for local installs. CI resolves the publisher with this precedence: manual workflow input `publisher` > `VSCE_PUBLISHER` > default `yanhuifair`.

Publish a tagged version:

```bash
git tag v0.7.0
git push origin v0.7.0
```

Or run **Publish VS Code Extension** manually from GitHub Actions. Checking `dry_run` packages and uploads the VSIX artifact without publishing it to the Marketplace.

One-off local publishing can still use a PAT: set `VSCE_PUBLISHER` and `VSCE_PAT`, then run `npm run publish:marketplace`. For ongoing releases, prefer the OIDC workflow.

## License

MIT
