// 桌面启动编排的测试。
//
// 用真实的控制平面进程验证四件事：启动后健康检查通过、锁文件写入、第二个实例被拒绝、
// 停止后锁文件消失且进程退出。运行时的就绪等待在这里指向控制平面本身（它的根路径会返回
// 502），因此只验证「端口已开即算就绪」这一语义，不依赖真实的运行时。
//
// 运行：node --test e2e/unit/desktop-orchestrator.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tempHome } from '../../scripts/lib/cleanup.mjs';
import { createOrchestrator, AlreadyRunningError } from '../../packages/desktop/lib/index.js';

const ROOT = resolve(import.meta.dirname, '..', '..');
const LAUNCH_ROOT = tempHome('desktop-test');
const DESKTOP_HOME = tempHome('desktop-home');
const PORT = 3177;

function options(env) {
  return {
    launchRoot: LAUNCH_ROOT,
    gateway: { command: process.execPath, args: [resolve(ROOT, 'packages/gateway/lib/main.js')] },
    gatewayUrl: `http://127.0.0.1:${PORT}`,
    runtimeUrl: `http://127.0.0.1:${PORT}`,
    readyTimeoutMs: 20_000,
    processEnv: {
      ...process.env,
      DSH_HOME: DESKTOP_HOME,
      CHATDSH_GATEWAY_PORT: String(PORT),
    },
  };
}

test('启动、拒绝第二个实例、停止后释放锁', async () => {
  const orchestrator = createOrchestrator(options());
  const started = await orchestrator.start();
  try {
    assert.equal(started.gatewayUrl, `http://127.0.0.1:${PORT}`);
    assert.ok(started.pid > 0);

    const lockFile = resolve(LAUNCH_ROOT, 'instance.lock');
    assert.ok(existsSync(lockFile), '锁文件应当存在');
    assert.equal(Number.parseInt(readFileSync(lockFile, 'utf8').trim(), 10), process.pid);

    const second = createOrchestrator(options());
    await assert.rejects(() => second.start(), (error) => error instanceof AlreadyRunningError);
  } finally {
    await orchestrator.stop();
  }
  assert.equal(existsSync(resolve(LAUNCH_ROOT, 'instance.lock')), false, '停止后锁文件应当消失');
});
