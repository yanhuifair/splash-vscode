import * as vscode from 'vscode';
import { SplashClient } from './client';
import { errorMessage, SplashModelProvider, type RequestState } from './provider';

const VENDOR = 'splash';
const API_KEY_SECRET = 'splash.apiKey';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('Splash');
  const log = (message: string) => output.appendLine(`[${new Date().toISOString()}] ${message}`);
  const provider = new SplashModelProvider(log);

  // apiKey 优先用系统钥匙串里的值:settings.json 是明文的,还会被 Settings Sync 同步走。
  provider.setApiKey((await context.secrets.get(API_KEY_SECRET)) ?? '');

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 40);
  status.command = 'splash.checkServer';

  let state: RequestState = 'idle';
  let failedTimer: ReturnType<typeof setTimeout> | undefined;
  const FAILED_BADGE_MS = 10_000;

  const render = () => {
    if (!vscode.workspace.getConfiguration('splash').get<boolean>('showStatusBar', true)) {
      status.hide();
      return;
    }
    // 生成中优先:本地模型首字慢,不提示的话会以为扩展没反应。
    if (state === 'failed') {
      status.text = '$(error) Splash · 请求失败';
      status.tooltip = `${provider.error ?? '最近一次请求失败'} — 点击检查服务状态(10 秒后恢复正常显示)`;
      status.show();
      return;
    }
    if (state !== 'idle') {
      status.text = state === 'waiting' ? '$(sync~spin) Splash · 等待响应' : '$(sync~spin) Splash · 生成中';
      status.tooltip = '正在与 splash 通信。首字迟迟不来通常是模型在加载权重或排队,可看 Output 面板 Splash 频道。';
      status.show();
      return;
    }
    const models = provider.currentModels;
    const error = provider.error;
    const current = provider.lastModel ?? models[0];
    if (models.length === 0) {
      if (error) {
        status.text = '$(circle-slash) Splash';
        status.tooltip = `Splash 未连接: ${error}`;
      } else {
        status.text = '$(debug-disconnect) Splash';
        status.tooltip = 'Splash 已连接,但没有匹配的模型(检查 splash.modelFilter)。';
      }
    } else {
      const more = models.length > 1 ? ` (+${models.length - 1})` : '';
      status.text = `${provider.isStale ? '$(warning)' : '$(cpu)'} Splash · ${current.name}${more}`;
      const header = provider.isStale ? `服务暂时连不上,显示的是上次结果: ${error}\n` : '';
      status.tooltip =
        header +
        models.map((model) => `${model.name} · 输入 ${model.maxInputTokens} / 输出 ${model.maxOutputTokens}`).join('\n');
    }
    status.show();
  };

  context.subscriptions.push(
    output,
    status,
    provider.onDidChangeLanguageModelChatInformation(() => render()),
    provider.onDidChangeRequestState((next) => {
      if (failedTimer) {
        clearTimeout(failedTimer);
        failedTimer = undefined;
      }
      state = next;
      if (next === 'failed') {
        failedTimer = setTimeout(() => {
          state = 'idle';
          render();
        }, FAILED_BADGE_MS);
      }
      render();
    }),
    { dispose: () => failedTimer && clearTimeout(failedTimer) },
    vscode.lm.registerLanguageModelChatProvider(VENDOR, provider),
    vscode.commands.registerCommand('splash.openLog', () => output.show(true)),
    vscode.commands.registerCommand('splash.refreshModels', async () => {
      const models = await provider.refresh(false);
      render();
      if (models.length) {
        void vscode.window.showInformationMessage(`Splash: 已加载 ${models.length} 个模型,可在聊天模型选择器中选择。`);
      }
    }),
    vscode.commands.registerCommand('splash.setApiKey', async () => {
      const existing = (await context.secrets.get(API_KEY_SECRET)) ?? '';
      const value = await vscode.window.showInputBox({
        title: 'Splash: 设置 API Key',
        prompt: existing
          ? '当前已保存一个 Key(存在系统钥匙串)。输入新的值覆盖,留空则清除。'
          : '对应 splash serve --api-key。存在系统钥匙串,不写进 settings.json。',
        password: true,
        ignoreFocusOut: true,
        placeHolder: existing ? '(留空并回车 = 清除)' : '没有设置 --api-key 就留空'
      });
      if (value === undefined) {
        return;
      }
      const trimmed = value.trim();
      if (trimmed) {
        await context.secrets.store(API_KEY_SECRET, trimmed);
      } else {
        await context.secrets.delete(API_KEY_SECRET);
      }
      provider.setApiKey(trimmed);
      log(trimmed ? 'API Key 已保存到系统钥匙串' : '已清除系统钥匙串里的 API Key');
      await provider.refresh(false);
      render();
      void vscode.window.showInformationMessage(
        trimmed ? 'Splash: API Key 已保存(系统钥匙串)。' : 'Splash: 已清除 API Key,回退到 splash.apiKey 设置。'
      );
    }),
    vscode.commands.registerCommand('splash.manage', async () => {
      const actions: { label: string; detail: string; command: string; argument?: string }[] = [
        { label: '检查本地服务状态', detail: '探测 /health 并刷新模型列表', command: 'splash.checkServer' },
        { label: '诊断模型', detail: '输出配置来源、模型列表与思考策略', command: 'splash.diagnoseModels' },
        { label: '设置 API Key', detail: '存到系统钥匙串，不写进 settings.json', command: 'splash.setApiKey' },
        { label: '刷新模型列表', detail: '重新读取 /v1/models', command: 'splash.refreshModels' },
        { label: '打开日志', detail: 'Output 面板 Splash 频道', command: 'splash.openLog' },
        { label: '打开设置', detail: '在设置里筛选 @splash', command: 'workbench.action.openSettings', argument: '@splash' }
      ];
      const choice = await vscode.window.showQuickPick(actions, {
        title: 'Splash · 管理模型提供程序',
        placeHolder: '选择要执行的操作'
      });
      if (choice) {
        await vscode.commands.executeCommand(choice.command, ...(choice.argument ? [choice.argument] : []));
      }
    }),
    vscode.commands.registerCommand('splash.diagnoseModels', async () => {
      output.show(true);
      output.appendLine(`[${new Date().toISOString()}] --- Diagnostics ---`);
      for (const line of provider.diagnosticLines()) {
        output.appendLine(line);
      }
      try {
        const all = await vscode.lm.selectChatModels();
        const ours = all.filter((model) => model.vendor === VENDOR);
        output.appendLine(`VS Code 返回 ${all.length} 个模型,其中 Splash ${ours.length} 个:`);
        for (const model of ours) {
          output.appendLine(`  - ${model.id} (${model.name})`);
        }
      } catch (error) {
        output.appendLine(`读取 VS Code 模型列表失败: ${errorMessage(error)}`);
      }

      const settings = provider.currentSettings();
      const client = new SplashClient(
        settings.baseUrl,
        settings.apiKey || undefined,
        { connectMs: 5_000, idleMs: 5_000, totalMs: 10_000 },
        settings.headers
      );
      try {
        output.appendLine(`/health: ${(await client.health()) ? 'ok' : '未就绪'}`);
      } catch (error) {
        output.appendLine(`/health 失败: ${errorMessage(error)}`);
      }
      try {
        const models = await client.listModels();
        output.appendLine(`/v1/models: ${models.length} 个`);
        for (const model of models.slice(0, 20)) {
          output.appendLine(`  - ${model.id}`);
        }
        if (models.length > 20) {
          output.appendLine(`  ... 还有 ${models.length - 20} 个`);
        }
      } catch (error) {
        output.appendLine(`/v1/models 失败: ${errorMessage(error)}`);
      }
      output.appendLine('--- End Diagnostics ---');
    }),
    vscode.commands.registerCommand('splash.checkServer', async () => {
      const settings = provider.currentSettings();
      try {
        const healthy = await new SplashClient(
          settings.baseUrl,
          settings.apiKey || undefined,
          await provider.currentTimeouts(settings),
          settings.headers
        ).health();
        const models = await provider.refresh(true);
        render();
        const detail = models.map((model) => model.name).join(', ') || '无';
        void vscode.window.showInformationMessage(
          `Splash @ ${settings.baseUrl} · ${healthy ? '健康' : '未就绪'} · 模型: ${detail}`
        );
      } catch (error) {
        render();
        void vscode.window.showErrorMessage(`Splash: ${errorMessage(error)}`);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('splash')) {
        void provider.refresh(true).then(render);
      }
    })
  );

  void provider.refresh(true).then(render);
}

export function deactivate(): void {
  // subscriptions are disposed by the extension host
}
