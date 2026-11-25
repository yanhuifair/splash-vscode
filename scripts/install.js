#!/usr/bin/env node
// 打包 + 安装到本机 VS Code。用法: node scripts/install.js [--skip-build]
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const outVsix = path.join(root, 'build', 'splash-model-provider.vsix');

const CODE_CLI_CANDIDATES = [
  process.env.CODE_CLI,
  'code',
  'code-insiders',
  '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
  '/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code',
  '/Applications/Cursor.app/Contents/Resources/app/bin/cursor',
  '/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf'
].filter(Boolean);

function run(command, args, label) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.error) {
    throw new Error(`${label} 启动失败: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${label} 失败:\n${(result.stderr || result.stdout || '').trim()}`);
  }
  return (result.stdout || '').trim();
}

function vsceBin() {
  const local = path.join(root, 'node_modules', '.bin', 'vsce');
  return fs.existsSync(local) ? local : 'npx';
}

function packageVsix() {
  const bin = vsceBin();
  fs.mkdirSync(path.dirname(outVsix), { recursive: true });
  const args = bin === 'npx'
    ? ['vsce', 'package', '--no-dependencies', '--allow-missing-repository', '-o', 'build/splash-model-provider.vsix']
    : ['package', '--no-dependencies', '--allow-missing-repository', '-o', 'build/splash-model-provider.vsix'];
  run(bin, args, 'vsce package');
  if (!fs.existsSync(outVsix)) {
    throw new Error(`没找到打包结果 ${outVsix}`);
  }
  return outVsix;
}

function findCodeCli() {
  for (const candidate of CODE_CLI_CANDIDATES) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0) {
      return { command: candidate, version: (probe.stdout || '').split('\n')[0] };
    }
  }
  return undefined;
}

function extensionId() {
  const pkg = require(path.join(root, 'package.json'));
  return `${pkg.publisher}.${pkg.name}`;
}

function installVsix(cli, vsix) {
  return run(cli.command, ['--install-extension', vsix, '--force'], 'code --install-extension');
}

function uninstallExisting(cli) {
  const result = spawnSync(cli.command, ['--uninstall-extension', extensionId()], { cwd: root, encoding: 'utf8' });
  return result.status === 0;
}

function main() {
  const version = require(path.join(root, 'package.json')).version;
  const vsix = packageVsix();
  const size = (fs.statSync(vsix).size / 1024).toFixed(1);
  console.log(`打包完成: build/splash-model-provider.vsix (${size} KB, v${version})`);

  const cli = findCodeCli();
  if (!cli) {
    console.error('未找到 VS Code 命令行。请在命令面板执行 "Shell Command: Install code command in PATH",或设置环境变量 CODE_CLI=/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code');
    process.exit(1);
  }

  let output;
  try {
    output = installVsix(cli, vsix);
  } catch (error) {
    // VS Code 会拒绝重装它已经加载的扩展("Please restart VS Code before reinstalling ..."),
    // 先卸载旧的再装就不必退出 VS Code。
    if (!/restart|in use|already installed/i.test(error.message)) {
      throw error;
    }
    if (!uninstallExisting(cli)) {
      throw error;
    }
    output = installVsix(cli, vsix);
    console.log('(旧版本已先卸载,重装无需退出 VS Code)');
  }
  console.log(`已安装到 ${cli.command} (${cli.version})`);
  if (output) {
    console.log(output);
  }
  console.log('提示: 若扩展正在运行,在 VS Code 里执行 Developer: Reload Window 即可加载新代码。');
}

try {
  main();
} catch (error) {
  console.error(`安装失败: ${error.message}`);
  process.exit(1);
}
