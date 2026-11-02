// WP14 终端展示的验收。
//
// 终端输出来自真实伪终端：`script -qec <命令> /dev/null` 在真实 PTY 里运行命令，返回的
// 字节带着回车重写与颜色转义序列。断言检查展示层把这些字节变成可读行、命令与输出分开、
// 断线重连不重放输入，以及读屏文本逐条可读。展示层不做屏幕模拟，只移除转义序列。
//
// 运行：node --test e2e/unit/client-complete-wp14-terminal.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';
import { ensureDeps } from '../lib/ensure-deps.mjs';

const execute = promisify(execFile);
const RUNTIME = resolve(import.meta.dirname, '../..');
ensureDeps(RUNTIME);
ensureBuilt();

const {
  TERMINAL_STATUS_TEXT,
  TerminalConsole,
  TerminalSession,
  announcementOf,
  terminalChunk,
} = await import('../../packages/client/workspace-tools/lib/terminal.js');

/** 构建本工作包的 TypeScript 产物，多个测试文件同时运行时串行。 */
function ensureBuilt() {
  const packages = ['packages/host/attachments', 'packages/host/voice', 'packages/client/workspace-tools'];
  const ready = () => packages.every((path) => existsSync(join(RUNTIME, path, 'lib/index.js')));
  if (ready()) return;
  const lock = join(RUNTIME, '.verify', 'wp14-build.lock');
  mkdirSync(join(RUNTIME, '.verify'), { recursive: true });
  const deadline = Date.now() + 240_000;
  for (;;) {
    if (ready()) return;
    try {
      mkdirSync(lock);
      break;
    } catch {
      if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > 300_000) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error('等待构建锁超时');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
    }
  }
  try {
    execFileSync(join(RUNTIME, 'node_modules/.bin/tsc'), ['-b', '--force', ...packages.map((path) => join(RUNTIME, path, 'tsconfig.json'))], {
      cwd: RUNTIME,
      stdio: 'inherit',
    });
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/**
 * 在真实伪终端里运行一条命令。
 * @param {string} command - shell 命令。
 * @returns {Promise<string>} 终端原始输出。
 */
async function runInPty(command) {
  const result = await execute('script', ['-qec', command, '/dev/null'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  return result.stdout;
}

test('真实 PTY 输出转成可读行', { timeout: 60_000 }, async () => {
  const home = allocateIndependentHome('wp14-pty');
  const workspace = join(home, 'ws');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'alpha.txt'), '甲\n');
  writeFileSync(join(workspace, 'beta.txt'), '乙\n');

  const colored = await runInPty(`cd ${JSON.stringify(workspace)} && ls --color=always && printf '\\033[31m红色提示\\033[0m\\n'`);
  assert.ok(colored.includes('\u001B['), '真实输出里带着颜色转义序列');
  const readable = terminalChunk(colored);
  assert.ok(readable.lines.every((line) => !line.includes('\u001B')), '转义序列被移除');
  assert.ok(readable.lines.some((line) => line.includes('alpha.txt')), '文件名保留');
  assert.ok(readable.lines.some((line) => line.includes('beta.txt')), '第二个文件名保留');
  assert.ok(readable.lines.some((line) => line.includes('红色提示')), '颜色文字保留');
  assert.ok(readable.bytes > 0);

  const progress = terminalChunk('准备中 10%\r准备中 50%\r准备中 100%\n完成\n');
  assert.deepEqual(progress.lines, ['准备中 100%', '完成'], '回车重写保留最后一次内容');

  const single = terminalChunk('\n\n第一行\n\n');
  assert.deepEqual(single.lines, ['', '', '第一行'], '末尾换行不留空项，行内空行保留');
  releaseIndependentHome(home);
});

test('命令与输出分开，断线不重放', { timeout: 60_000 }, async () => {
  const session = new TerminalSession('terminal-1', '/workspace', { now: () => 1_700_000_000_000 });
  assert.equal(session.state, 'connecting');
  assert.equal(TERMINAL_STATUS_TEXT.connecting, '正在连接');
  assert.throws(() => session.submit('ls'), /终端没有连接/);

  session.connected('/workspace/project');
  assert.equal(session.state, 'connected');
  assert.equal(session.cwd, '/workspace/project');
  const commandEntry = session.submit('ls -la');
  assert.equal(commandEntry.kind, 'command');
  assert.equal(session.lastInput, 'ls -la');

  const outputText = await runInPty('printf "总量 12\\n甲文件\\n乙文件\\n"');
  const appended = session.append(outputText);
  assert.ok(appended.length >= 3);
  assert.ok(appended.every((entry) => entry.kind === 'output'));
  assert.equal(session.output[0].kind, 'command', '第一条是命令');
  assert.ok(session.output.slice(1).every((entry) => entry.kind === 'output'), '之后是输出');
  assert.ok(session.viewText().startsWith('$ ls -la'), '复制文本的命令带提示符');
  assert.match(session.screenReaderText(), /^命令：ls -la\n输出：/u);

  session.disconnect();
  assert.equal(session.state, 'disconnected');
  assert.throws(() => session.submit('pwd'), /终端没有连接/);
  const reconnected = session.reconnect();
  assert.deepEqual(reconnected.replayedInputs, [], '重连不重放任何输入');
  assert.match(reconnected.notice, /不会重发/u);
  assert.equal(session.state, 'connected');
  assert.equal(session.output.at(-1).kind, 'notice');
  assert.equal(announcementOf(session.output.at(-1)), `提示：${reconnected.notice}`);

  assert.throws(() => session.close(false), /关闭需要确认/);
  const closed = session.close(true);
  assert.equal(closed.processDisposition, 'terminate');
  assert.equal(session.state, 'closed');
  assert.throws(() => session.append('迟到的输出'), /终端已关闭/);
  assert.throws(() => session.reconnect(), /终端已关闭/);
});

test('多终端切换与读屏文本', { timeout: 30_000 }, async () => {
  const console = new TerminalConsole();
  const first = console.create('t-1', '/workspace');
  const second = console.create('t-2', '/workspace/sub');
  assert.equal(console.current, second);
  first.connected();
  second.connected();
  second.submit('pwd');
  second.append(' /workspace/sub \r\n');
  assert.deepEqual(console.list().map((session) => session.id), ['t-1', 't-2']);
  assert.equal(console.select('t-1'), first);
  assert.equal(console.current, first);
  assert.throws(() => console.create('t-1', '/workspace'), /已经存在/);
  assert.throws(() => console.select('t-404'), /不存在/);
  for (const entry of second.output) assert.ok(announcementOf(entry) !== '');
});
