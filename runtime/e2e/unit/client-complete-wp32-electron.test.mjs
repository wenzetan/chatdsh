// WP32 真实 Electron 自检。
//
// 在 xvfb 里启动真实 Electron 主进程，执行 `desktop/electron/wp32-smoke.mjs`：核对菜单构建、
// 托盘位图、窗口边界恢复到真实显示器、剪贴板、电源阻止、通知能力，以及预加载桥在真实渲染
// 进程里的暴露面与来源校验。缺少 electron 或 xvfb 时明确跳过，并记录原因。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tempHome } from '../../scripts/lib/cleanup.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..');
const ELECTRON_DIR = join(ROOT, 'desktop', 'electron');
const ELECTRON_BIN = join(ELECTRON_DIR, 'node_modules', 'electron', 'dist', 'electron');
const SMOKE = join(ELECTRON_DIR, 'wp32-smoke.mjs');

/** 判定 xvfb 是否可用。 */
function hasXvfb() {
  const result = spawnSync('sh', ['-c', 'command -v xvfb-run'], { encoding: 'utf8' });
  return result.status === 0;
}

test('真实 Electron 下的桌面能力自检', { timeout: 180_000 }, async (context) => {
  if (!existsSync(ELECTRON_BIN)) {
    context.skip(`没有安装 electron：${ELECTRON_BIN}`);
    return;
  }
  if (!hasXvfb()) {
    context.skip('没有 xvfb-run，无法在无显示环境下启动 Electron');
    return;
  }
  const home = tempHome('wp32-electron');
  const out = join(home, 'smoke.json');
  mkdirSync(join(home, 'config'), { recursive: true });
  mkdirSync(join(home, 'cache'), { recursive: true });
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_CACHE_HOME: join(home, 'cache'),
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    WP32_SMOKE_OUT: out,
  };
  const child = spawn('xvfb-run', ['-a', '-s', '-screen 0 1440x900x24', ELECTRON_BIN, '--no-sandbox', SMOKE], {
    cwd: ELECTRON_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((settle) => child.once('exit', settle));

  assert.equal(code, 0, `Electron 自检退出码 ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  assert.equal(existsSync(out), true, '自检结果文件没有生成');
  const payload = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(payload.platform, 'linux');
  assert.equal(payload.ok, true, `自检失败项：${JSON.stringify(payload.results.filter((item) => item.ok !== true))}`);
  const byName = Object.fromEntries(payload.results.map((item) => [item.name, item]));

  assert.ok(byName.display.detail.count >= 1, '应当至少有一个显示器');
  assert.deepEqual(byName.menu.detail.groups, ['文件', '编辑', '视图', '会话', '帮助']);
  assert.equal(byName['tray-image'].detail.empty, false, '托盘位图应当是非空图像');
  assert.equal(byName['preload-surface'].detail.nodeRequire, 'undefined');
  assert.equal(byName['preload-surface'].detail.nodeProcess, 'undefined');
  assert.equal(byName['preload-surface'].detail.ipcRenderer, 'undefined');
  assert.deepEqual(byName['preload-surface'].detail.namespaces, ['activity', 'keepAlive', 'login', 'logs', 'native', 'notifications', 'onMenuAction', 'platform', 'power', 'startup', 'status', 'updates', 'window']);
  assert.equal(byName['untrusted-sender-rejected'].detail.verdict, 'rejected');
  assert.deepEqual(byName['trusted-sender-accepted'].detail, { probe: 'ok' });
  assert.ok(byName['window-restore'].detail.adjustments.includes('display-changed'), '屏幕外状态应当回到主显示器');
  const applied = byName['window-restore'].detail.applied;
  const workArea = byName.display.detail.workArea;
  assert.ok(applied.width <= workArea.width, `窗口宽度 ${applied.width} 超出可用区域 ${workArea.width}`);
  assert.ok(applied.height <= workArea.height, `窗口高度 ${applied.height} 超出可用区域 ${workArea.height}`);
  assert.ok(applied.x >= workArea.x && applied.x + applied.width <= workArea.x + workArea.width, '窗口水平位置超出可用区域');
  assert.ok(applied.y >= workArea.y && applied.y + applied.height <= workArea.y + workArea.height, '窗口垂直位置超出可用区域');
  assert.equal(byName.clipboard.detail.text, 'chatdsh-wp32-clipboard');
  assert.equal(byName['power-blocker'].detail.started, true);
  assert.equal(byName['power-blocker'].detail.stopped, true);
  assert.equal(byName['dialog-api'].detail.openDialog, true);
  assert.equal(byName['login-item'].detail.support.supported, false, 'Linux 上不应声明支持开机启动');
  assert.equal(byName['recovery-page'].detail.stage, 'runtime');
  assert.equal(byName['recovery-page'].detail.hasFailure, 'function');
  assert.equal(byName['recovery-page'].detail.hasSafeMode, 'function');
  assert.equal(byName['recovery-page'].detail.nodeRequire, 'undefined');
});
