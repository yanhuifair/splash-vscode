#!/usr/bin/env node
// 监视源码:每次保存后 编译 -> 打包 -> 安装到本机 VS Code。用法: npm run dev
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const watchTargets = [
  { dir: path.join(root, 'src'), recursive: true, pattern: /\.(ts|json)$/ },
  { dir: root, recursive: false, pattern: /^package\.json$/ }
];

const debounceMs = Number(process.env.SPLASH_WATCH_DEBOUNCE_MS || 400);
let timer;
let running = false;
let queued = false;

const stamp = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
const tscBin = path.join(root, 'node_modules', '.bin', 'tsc');

function build() {
  const started = Date.now();
  const compile = spawnSync(tscBin, ['-p', '.'], { cwd: root, encoding: 'utf8' });
  if (compile.status !== 0) {
    console.log(`[${stamp()}] 编译失败\n${(compile.stdout || compile.stderr || '').trim()}`);
    return;
  }
  const install = spawnSync(process.execPath, [path.join(root, 'scripts', 'install.js')], { cwd: root, encoding: 'utf8' });
  if (install.status !== 0) {
    console.log(`[${stamp()}] 安装失败\n${(install.stdout || install.stderr || '').trim()}`);
    return;
  }
  const last = (install.stdout || '').trim().split('\n').find((line) => line.startsWith('已安装到')) || '已安装';
  console.log(`[${stamp()}] ${last} · ${Date.now() - started} ms · 在 VS Code 里 Reload Window 生效`);
}

function cycle() {
  if (running) {
    queued = true;
    return;
  }
  running = true;
  try {
    build();
  } finally {
    running = false;
    if (queued) {
      queued = false;
      cycle();
    }
  }
}

function schedule(reason) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    console.log(`[${stamp()}] 检测到改动: ${reason}`);
    cycle();
  }, debounceMs);
}

for (const target of watchTargets) {
  if (!fs.existsSync(target.dir)) {
    continue;
  }
  fs.watch(target.dir, { recursive: target.recursive }, (_event, filename) => {
    if (!filename || !target.pattern.test(filename)) {
      return;
    }
    schedule(filename);
  });
}

console.log(`[${stamp()}] 监视中:src/*.ts 与 package.json 改动会自动 编译+打包+安装 (Ctrl+C 停止)`);
cycle();
