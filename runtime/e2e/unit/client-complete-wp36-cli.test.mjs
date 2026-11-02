// WP36 验收：本机 CLI、非交互 JSON 行协议、审批与断线恢复。
//
// 命令行按真实子进程启动本机运行时：`dsh --profile chatdsh-acp` 以 stdio 上的 ACP 提供会话、
// 配置与权限请求，不经过控制平面，也没有任何设备参数。每个用例使用独立数据根，profile 目录
// 从 e2e/profiles 链接进来，退出时释放。
//
// 运行：node --test e2e/unit/client-complete-wp36-cli.test.mjs
// 前置：首次运行时用仓库内的 tsc 编译 packages/client/cli。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';

const RUNTIME = resolve(import.meta.dirname, '../..');
const CLI_ENTRY = join(RUNTIME, 'packages/client/cli/lib/bin.js');
const CLI_PACKAGE = join(RUNTIME, 'packages/client/cli');
const PROFILE = 'chatdsh-acp';
const PROFILE_DIR = join(RUNTIME, 'e2e', 'profiles', PROFILE);
const NODE = process.execPath;

/** 真实伪终端；node-pty 来自仓库的依赖投影。 */
const { spawn: spawnPty } = await import(join(RUNTIME, '.dsh-deps', 'node-pty', 'lib', 'index.js'));

ensureWorkspaceLinks();
ensureBuilt();

/** 建立本包的依赖链接，内容与 pnpm 安装之后一致。 */
function ensureWorkspaceLinks() {
  const modules = join(CLI_PACKAGE, 'node_modules');
  mkdirSync(join(modules, '@chatdsh'), { recursive: true });
  const links = [
    ['@chatdsh/core-contracts', '../../../../core/contracts'],
    ['@chatdsh/core-diagnostics', '../../../../core/diagnostics'],
    ['zod', '../../../../node_modules/.pnpm/zod@4.4.3/node_modules/zod'],
  ];
  for (const [name, target] of links) {
    const link = join(modules, name);
    if (existsSync(link)) continue;
    mkdirSync(join(link, '..'), { recursive: true });
    symlinkSync(target, link, 'dir');
  }
}

/** 编译本工作包的 TypeScript 产物；多个测试文件同时运行时串行。 */
function ensureBuilt() {
  const ready = () => existsSync(join(CLI_PACKAGE, 'lib', 'bin.js'));
  if (ready()) return;
  const lock = join(RUNTIME, '.verify', 'wp36-build.lock');
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
    execFileSync(join(RUNTIME, 'node_modules/.bin/tsc'), ['-b', '--force', join(CLI_PACKAGE, 'tsconfig.json')], {
      cwd: RUNTIME,
      stdio: 'inherit',
    });
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/**
 * 分配独立数据根，并把真实 profile 目录链接进去。
 * @param {string} prefix
 */
function makeHome(prefix) {
  const home = allocateIndependentHome(prefix);
  mkdirSync(join(home, 'profiles'), { recursive: true });
  symlinkSync(PROFILE_DIR, join(home, 'profiles', PROFILE));
  return home;
}

/** 关闭遥测的公共环境。 */
const TELEMETRY_OFF = { CHATDSH_TELEMETRY: 'off' };

/** 一条命令行进程。 */
class CliProcess {
  /**
   * @param {{ home: string, args?: string[], env?: Record<string, string> }} options
   */
  constructor(options) {
    this.child = spawn(NODE, [CLI_ENTRY, ...(options.args ?? [])], {
      cwd: RUNTIME,
      env: { ...process.env, DSH_HOME: options.home, ...(options.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.lines = [];
    this.raw = [];
    this.stderr = '';
    this.buffer = '';
    this.exited = new Promise((resolveExit) => {
      this.child.on('exit', (code, signal) => resolveExit({ code, signal }));
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      let index = this.buffer.indexOf('\n');
      while (index >= 0) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (line !== '') {
          this.raw.push(line);
          try {
            this.lines.push(JSON.parse(line));
          } catch {
            // 文本模式的行不是协议行，记在 raw 里。
          }
        }
        index = this.buffer.indexOf('\n');
      }
    });
    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk;
    });
  }

  /**
   * 发送一条请求。
   * @param {object} request
   */
  send(request) {
    this.child.stdin.write(`${JSON.stringify(request)}\n`);
  }

  /**
   * 等待一条满足条件的输出行。
   * @param {(line: object) => boolean} predicate
   * @param {number} timeoutMs
   */
  async waitFor(predicate, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.lines.find(predicate);
      if (found !== undefined) return found;
      if (Date.now() > deadline) throw new Error(`等待输出行超时，已收到 ${this.lines.length} 行`);
      await new Promise((settle) => setTimeout(settle, 50));
    }
  }

  /** 结束输入并等待退出。 */
  async close() {
    this.child.stdin.end();
    return this.exited;
  }

  /** 发送信号。 */
  kill(signal) {
    this.child.kill(signal);
  }
}

/**
 * 一次性运行命令行。
 * @param {{ home: string, args?: string[], input?: string, env?: Record<string, string> }} options
 */
async function runCli(options) {
  const process_ = new CliProcess(options);
  if (options.input !== undefined && options.input !== '') {
    for (const line of options.input.split('\n')) {
      if (line.trim() === '') continue;
      process_.child.stdin.write(`${line}\n`);
    }
  }
  const exit = await process_.close();
  return { ...exit, lines: process_.lines, raw: process_.raw, stderr: process_.stderr };
}

/**
 * 断言每一行都是可解析的协议对象。
 * @param {object[]} lines
 */
function assertProtocolLines(lines) {
  assert.ok(lines.length > 0, '至少产出一行');
  for (const line of lines) {
    assert.equal(typeof line, 'object', `行是对象：${JSON.stringify(line)}`);
    assert.equal(line.protocol, 'chatdsh.cli/1', '每行都带协议标识');
    assert.equal(typeof line.at, 'string', '每行都带时间戳');
  }
}

/**
 * 取应答行。
 * @param {object[]} lines
 * @param {string} id
 */
function responseOf(lines, id) {
  const found = lines.find((line) => line.id === id && line.ok !== undefined);
  assert.ok(found !== undefined, `存在 id=${id} 的应答`);
  return found;
}

/**
 * 在真实伪终端里运行命令行。
 *
 * 伪终端由 node-pty 分配：输入按键进入原始模式，因此 Tab 补全与终端尺寸调整都走真实路径。
 * @param {{
 *   home: string,
 *   cols?: number,
 *   rows?: number,
 *   args?: string[],
 *   env?: Record<string, string>,
 *   timeoutMs?: number,
 *   steps?: { delay?: number, write?: string, resize?: { cols: number, rows?: number } }[],
 * }} options
 * @returns {Promise<{ output: string, code: number | null }>}
 */
async function runPty(options) {
  const pty = spawnPty(NODE, [CLI_ENTRY, ...(options.args ?? [])], {
    name: 'xterm-256color',
    cols: options.cols ?? 100,
    rows: options.rows ?? 30,
    cwd: RUNTIME,
    env: { ...process.env, DSH_HOME: options.home, ...(options.env ?? {}) },
  });
  let output = '';
  pty.onData((chunk) => {
    output += chunk;
  });
  const exited = new Promise((resolveExit) => pty.onExit(({ exitCode }) => resolveExit(exitCode)));
  const timer = setTimeout(() => pty.kill(), options.timeoutMs ?? 120_000);
  for (const step of options.steps ?? []) {
    if (step.delay !== undefined) await new Promise((settle) => setTimeout(settle, step.delay));
    if (step.write !== undefined) pty.write(step.write);
    if (step.resize !== undefined) pty.resize(step.resize.cols, step.resize.rows ?? 30);
  }
  const code = await exited;
  clearTimeout(timer);
  return { output: output.replaceAll('\r\n', '\n'), code };
}

/**
 * 运行一段 bash。
 * @param {string} command
 * @param {{ cwd: string, env?: Record<string, string> }} options
 */
function runBash(command, options) {
  return new Promise((resolveBash, rejectBash) => {
    const child = spawn('bash', ['-c', command], {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', rejectBash);
    child.on('exit', (code) => resolveBash({ code, stdout, stderr }));
  });
}

/**
 * 等待进程消失。
 * @param {number} pid
 * @param {number} timeoutMs
 */
async function waitGone(pid, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() > deadline) return false;
    await new Promise((settle) => setTimeout(settle, 100));
  }
}

test('非交互行协议：逐行 JSON、请求与应答配对、用法错误退出码 2', { timeout: 180_000 }, async () => {
  const home = makeHome('wp36-lines');
  try {
    const requests = [
      { id: 'a', command: 'command.tree' },
      { id: 'b', line: 'extension.list' },
      { id: 'c', command: 'help', arguments: { target: 'session.send' } },
      { id: 'd', command: 'session.nope' },
      { id: 'e', line: 'session.new --bogus 1' },
      { id: 'f', command: 'command.complete', arguments: { prefix: 'sess' } },
    ].map((entry) => JSON.stringify(entry));
    requests.push('{不是 JSON');
    const result = await runCli({ home, input: `${requests.join('\n')}\n`, env: TELEMETRY_OFF });
    assert.equal(result.code, 2, `出现用法错误时退出码为 2，stderr=${result.stderr}`);
    assertProtocolLines(result.lines);
    assert.equal(responseOf(result.lines, 'a').ok, true, 'command.tree 成功');
    assert.equal(responseOf(result.lines, 'b').ok, true, '命令行文本形式的请求成功');
    assert.equal(responseOf(result.lines, 'c').ok, true, 'help 成功');
    const unknown = responseOf(result.lines, 'd');
    assert.equal(unknown.ok, false, '未知命令失败');
    assert.equal(unknown.error.code, 'usage', '未知命令属于用法错误');
    const badFlag = responseOf(result.lines, 'e');
    assert.equal(badFlag.error.code, 'usage', '未知可选项属于用法错误');
    const completed = responseOf(result.lines, 'f');
    assert.ok(completed.result.candidates.includes('session.new'), '补全给出会话命令');
    assert.ok(completed.result.candidates.includes('session.send'), '补全给出全部会话命令');
    const unparsable = result.lines.find((line) => line.ok === false && line.id === '-');
    assert.ok(unparsable !== undefined, '无法解析的请求行得到失败应答');
    assert.equal(unparsable.error.code, 'usage');
    for (const line of result.raw) {
      assert.doesNotThrow(() => JSON.parse(line), 'stdout 每行都能被 JSON.parse');
    }
  } finally {
    releaseIndependentHome(home);
  }
});

test('单条执行与状态栏：不依赖运行时的命令成功退出 0', { timeout: 120_000 }, async () => {
  const home = makeHome('wp36-once');
  try {
    const status = await runCli({ home, args: ['--json', '-e', 'status'], env: TELEMETRY_OFF });
    assert.equal(status.code, 0, `status 退出码 0，stderr=${status.stderr}`);
    const line = responseOf(status.lines, 'single');
    assert.equal(line.ok, true);
    assert.equal(line.result.state, 'idle', '没有连接时状态是 idle');
    assert.equal(line.result.pendingApprovals, 0);
    const telemetryEntry = line.result.entries.find((entry) => entry.id === 'telemetry');
    assert.equal(telemetryEntry.value, '关闭（env）', '关闭来源报告为 env');

    const tree = await runCli({ home, args: ['--json', 'command', 'tree'], env: TELEMETRY_OFF });
    assert.equal(tree.code, 0, `命令组与子命令的空格写法可用，stderr=${tree.stderr}`);
    const groups = responseOf(tree.lines, 'single').result.groups.map((group) => group.id);
    for (const expected of ['scene', 'settings', 'command', 'extension', 'session', 'approval', 'workspace', 'status']) {
      assert.ok(groups.includes(expected), `命令树包含 ${expected} 组`);
    }

    const version = await runCli({ home, args: ['--version'], env: TELEMETRY_OFF });
    assert.equal(version.code, 0);
    assert.deepEqual(version.raw, [version.raw[0]], '--version 只打印一行');
    assert.match(version.raw[0], /^\d+\.\d+\.\d+$/u, '打印版本号');
  } finally {
    releaseIndependentHome(home);
  }
});

test('真实运行时：创建、关闭、列表、恢复与配置更新', { timeout: 240_000 }, async () => {
  const home = makeHome('wp36-session');
  try {
    const result = await runCli({
      home,
      env: TELEMETRY_OFF,
      input: [
        JSON.stringify({ id: '1', command: 'session.new', arguments: {} }),
        JSON.stringify({ id: '2', command: 'session.list', arguments: {} }),
        JSON.stringify({ id: '3', command: 'settings.set', arguments: { option: 'reasoning_effort', value: 'off' } }),
        JSON.stringify({ id: '4', command: 'session.close', arguments: { yes: true } }),
        JSON.stringify({ id: '5', command: 'session.list', arguments: {} }),
        JSON.stringify({ id: '6', command: 'scene.open', arguments: { scene: 'diagnostics' } }),
      ].join('\n') + '\n',
    });
    assert.equal(result.code, 0, `全部请求成功，stderr=${result.stderr}`);
    assertProtocolLines(result.lines);
    const opened = result.lines.find((line) => line.event === 'channel.open');
    assert.ok(opened !== undefined, '通道打开事件出现在 stdout');
    assert.equal(opened.protocolVersion, 1, 'ACP 协议版本为 1');
    assert.equal(typeof opened.pid, 'number', '通道公布运行时子进程标识');

    const created = responseOf(result.lines, '1');
    assert.equal(created.ok, true, `新建会话成功，error=${JSON.stringify(created.error)}`);
    const sessionId = created.result.sessionId;
    assert.match(sessionId, /^[0-9a-f-]{36}$/u, '会话标识是运行时生成的不透明标识');
    assert.ok(created.result.configOptions.some((option) => option.id === 'model'), '会话公布模型配置项');
    assert.ok(
      created.result.configOptions.some((option) => option.id === 'reasoning_effort'),
      '会话公布推理强度配置项',
    );

    const activeList = responseOf(result.lines, '2');
    assert.ok(
      !activeList.result.sessions.some((entry) => entry.sessionId === sessionId),
      '活跃会话不出现在可恢复列表里',
    );

    const updated = responseOf(result.lines, '3');
    assert.equal(updated.ok, true, `配置更新成功，error=${JSON.stringify(updated.error)}`);
    const effort = updated.result.options.find((option) => option.id === 'reasoning_effort');
    assert.equal(effort.currentValue, 'off', '推理强度改成 off');

    const closed = responseOf(result.lines, '4');
    assert.equal(closed.ok, true, '关闭会话成功');
    assert.ok(
      result.lines.some((line) => line.event === 'session.closed' && line.sessionId === sessionId),
      '关闭事件出现在 stdout',
    );

    const afterClose = responseOf(result.lines, '5');
    assert.ok(
      afterClose.result.sessions.some((entry) => entry.sessionId === sessionId),
      '关闭之后的会话进入可恢复列表',
    );

    const diagnostics = responseOf(result.lines, '6');
    assert.equal(diagnostics.ok, true);
    assert.ok(diagnostics.result.stats.transport.requests >= 5, '诊断场景报告真实协议计数');
  } finally {
    releaseIndependentHome(home);
  }
});

test('恢复同一本机会话：跨进程恢复成功，恢复已活跃会话被明确拒绝', { timeout: 240_000 }, async () => {
  const home = makeHome('wp36-resume');
  try {
    const created = await runCli({
      home,
      env: TELEMETRY_OFF,
      input: `${JSON.stringify({ id: '1', command: 'session.new', arguments: { cwd: RUNTIME } })}\n${JSON.stringify({ id: '2', command: 'session.close', arguments: { yes: true } })}\n`,
    });
    assert.equal(created.code, 0, `建立会话并关闭，stderr=${created.stderr}`);
    const sessionId = responseOf(created.lines, '1').result.sessionId;

    const resumed = await runCli({
      home,
      env: TELEMETRY_OFF,
      input: `${JSON.stringify({ id: '1', command: 'session.resume', arguments: { sessionId, cwd: RUNTIME } })}\n`,
    });
    assert.equal(resumed.code, 0, `跨进程恢复成功，stderr=${resumed.stderr}`);
    const record = responseOf(resumed.lines, '1');
    assert.equal(record.ok, true, `恢复返回成功，error=${JSON.stringify(record.error)}`);
    assert.equal(record.result.sessionId, sessionId, '恢复的是同一个会话标识');

    const conflict = await runCli({
      home,
      env: TELEMETRY_OFF,
      input: [
        JSON.stringify({ id: '1', command: 'session.resume', arguments: { sessionId, cwd: RUNTIME } }),
        JSON.stringify({ id: '2', command: 'session.resume', arguments: { sessionId, cwd: RUNTIME } }),
      ].join('\n') + '\n',
    });
    assert.equal(responseOf(conflict.lines, '1').ok, true, '第一次恢复成功');
    const conflictLine = conflict.lines.find((line) => line.id === '2');
    assert.equal(conflictLine.ok, false, '恢复已活跃会话被拒绝');
    assert.equal(conflictLine.error.code, 'runtime', '运行时拒绝按运行时错误报告');
    assert.equal(conflict.code, 1, '只有运行时错误时退出码为 1');
    assert.match(conflictLine.error.message, /already active|恢复/u, '错误信息说明原因');
  } finally {
    releaseIndependentHome(home);
  }
});

test('断线恢复：断开后发送失败，重连按标识去重不重发', { timeout: 240_000 }, async () => {
  const home = makeHome('wp36-reconnect');
  const cli = new CliProcess({ home, env: TELEMETRY_OFF });
  try {
    cli.send({ id: '1', command: 'session.new', arguments: {} });
    const opened = await cli.waitFor((line) => line.event === 'channel.open');
    const runtimePid = opened.pid;
    const created = await cli.waitFor((line) => line.id === '1');
    assert.equal(created.ok, true, `会话建立成功，error=${JSON.stringify(created.error)}`);
    const sessionId = created.result.sessionId;

    // 会话先关闭再恢复，重连时才能从可恢复列表里重新打开。
    cli.send({ id: '2', command: 'session.close', arguments: { yes: true } });
    await cli.waitFor((line) => line.id === '2');
    cli.send({ id: '3', command: 'session.resume', arguments: { sessionId } });
    const resumed = await cli.waitFor((line) => line.id === '3');
    assert.equal(resumed.ok, true, `会话恢复成功，error=${JSON.stringify(resumed.error)}`);

    // 第一次投递：内容交给运行时；缺少模型凭据时运行时报错，但投递已经发生。
    cli.send({ id: '4', command: 'session.send', arguments: { text: '第一条', delivery: 'm-1' } });
    const first = await cli.waitFor((line) => line.id === '4');
    assert.equal(first.ok, false, '缺少模型凭据时发送失败');
    assert.equal(first.error.code, 'runtime', '运行时失败按 runtime 报告');
    assert.match(first.error.message, /API key|凭据|turn failed/u, '错误信息说明缺少凭据');

    cli.send({ id: '5', command: 'scene.open', arguments: { scene: 'diagnostics' } });
    const beforeKill = await cli.waitFor((line) => line.id === '5');
    const writesBeforeKill = beforeKill.result.stats.transport.writes;
    assert.ok(writesBeforeKill >= 4, `断线前已写入 ${writesBeforeKill} 帧`);

    // 断开本机运行时：直接终止子进程。
    process.kill(runtimePid, 'SIGKILL');
    const offline = await cli.waitFor((line) => line.event === 'channel.offline', 30_000);
    assert.match(String(offline.reason), /已退出/u, '离线事件说明运行时已退出');

    cli.send({ id: '6', command: 'session.send', arguments: { text: '第二条', delivery: 'm-2' } });
    const offlineSend = await cli.waitFor((line) => line.id === '6');
    assert.equal(offlineSend.ok, false, '断开之后发送失败');
    assert.equal(offlineSend.error.code, 'offline', '断开之后按 offline 报告，不排队');
    assert.match(offlineSend.error.message, /没有投递/u, '错误信息说明内容没有投递');

    cli.send({ id: '7', command: 'status.reconnect', arguments: {} });
    const reconnected = await cli.waitFor((line) => line.id === '7', 120_000);
    assert.equal(reconnected.ok, true, `重连成功，error=${JSON.stringify(reconnected.error)}`);
    assert.ok(reconnected.result.resumed.includes(sessionId), '重连恢复了断开前的会话');

    cli.send({ id: '8', command: 'scene.open', arguments: { scene: 'diagnostics' } });
    const afterReconnect = await cli.waitFor((line) => line.id === '8');
    const writesAfterReconnect = afterReconnect.result.stats.transport.writes;
    assert.equal(afterReconnect.result.stats.reconnects, 1, '重连次数记 1');
    assert.equal(afterReconnect.result.stats.delivered, 1, '台账里仍然只有第一条投递');

    // 同一标识再发一次：不写第二遍。
    cli.send({ id: '9', command: 'session.send', arguments: { text: '第一条', delivery: 'm-1' } });
    const duplicated = await cli.waitFor((line) => line.id === '9');
    assert.equal(duplicated.ok, true, `重复投递返回成功，(error=${JSON.stringify(duplicated.error)})`);
    assert.equal(duplicated.result.duplicated, true, '同一标识被判定为重复提交');
    assert.equal(duplicated.result.id, 'm-1', '返回第一次的投递记录');

    cli.send({ id: '10', command: 'scene.open', arguments: { scene: 'diagnostics' } });
    const afterDedupe = await cli.waitFor((line) => line.id === '10');
    assert.equal(
      afterDedupe.result.stats.transport.writes,
      writesAfterReconnect,
      '重复提交没有向运行时写出任何一帧',
    );

    // 新标识照常投递，仍按真实缺凭据失败。
    cli.send({ id: '11', command: 'session.send', arguments: { text: '第三条', delivery: 'm-3' } });
    const third = await cli.waitFor((line) => line.id === '11');
    assert.equal(third.ok, false, '新标识确实投递到运行时');
    assert.equal(third.error.code, 'runtime', '新标识按运行时错误报告');

    cli.send({ id: '12', command: 'scene.open', arguments: { scene: 'diagnostics' } });
    const afterThird = await cli.waitFor((line) => line.id === '12');
    assert.equal(
      afterThird.result.stats.transport.writes,
      writesAfterReconnect + 1,
      '新标识写出一帧，重复标识一帧也不写',
    );
    assert.equal(afterThird.result.stats.delivered, 2, '台账在第二次新投递之后记两条');

    const exit = await cli.close();
    assert.equal(exit.code, 1, '本次运行有运行时错误，退出码为 1');
    assertProtocolLines(cli.lines);
    for (const line of cli.raw) assert.doesNotThrow(() => JSON.parse(line), 'stdout 每行都能被 JSON.parse');
  } finally {
    cli.child.kill('SIGKILL');
    releaseIndependentHome(home);
  }
});

test('取消回合与无跨设备入口：取消走真实通知，命令树不提供设备参数', { timeout: 180_000 }, async () => {
  const home = makeHome('wp36-cancel');
  try {
    const result = await runCli({
      home,
      env: TELEMETRY_OFF,
      input: [
        JSON.stringify({ id: '1', command: 'session.new', arguments: {} }),
        JSON.stringify({ id: '2', command: 'session.cancel', arguments: {} }),
        JSON.stringify({ id: '3', command: 'scene.open', arguments: { scene: 'diagnostics' } }),
        JSON.stringify({ id: '4', command: 'command.tree', arguments: {} }),
        JSON.stringify({ id: '5', command: 'extension.list', arguments: {} }),
      ].join('\n') + '\n',
    });
    assert.equal(result.code, 0, `全部请求成功，stderr=${result.stderr}`);
    assert.equal(responseOf(result.lines, '2').ok, true, '取消请求被接受');
    assert.equal(responseOf(result.lines, '2').result.cancelled, true);
    const diagnostics = responseOf(result.lines, '3');
    assert.equal(diagnostics.result.stats.transport.notifications, 1, '取消以通知帧写出');

    const tree = responseOf(result.lines, '4').result;
    const commands = tree.groups.flatMap((group) => group.commands);
    assert.ok(commands.every((command) => !command.usage.includes('--device')), '命令树没有设备参数');
    assert.ok(commands.every((command) => !command.id.includes('device')), '命令树没有跨设备命令');
    assert.ok(commands.every((command) => !command.usage.includes('--runtime')), '命令树不能指向其他运行时');

    const extensions = responseOf(result.lines, '5').result;
    const local = extensions.extensionPoints.find((point) => point.id === 'channel.local');
    assert.ok(local !== undefined, '扩展点里有本机 Channel');
    assert.match(local.summary, /本机|控制平面/u, '本机 Channel 说明只用本机运行时');
    assert.equal(extensions.runtime.connected, true, '扩展清单报告运行时已连接');
  } finally {
    releaseIndependentHome(home);
  }
});

test('审批：没有待应答请求时不挂起，未知请求明确拒绝', { timeout: 180_000 }, async () => {
  const home = makeHome('wp36-approval');
  try {
    const started = Date.now();
    const result = await runCli({
      home,
      env: TELEMETRY_OFF,
      args: ['--approval-timeout', '2000'],
      input: [
        JSON.stringify({ id: '1', command: 'session.new', arguments: {} }),
        JSON.stringify({ id: '2', command: 'approval.list', arguments: {} }),
        JSON.stringify({ id: '3', command: 'approval.answer', arguments: { requestId: 'no-such-request', decision: 'allow' } }),
        JSON.stringify({ id: '4', command: 'session.send', arguments: { text: '需要审批的回合' } }),
        JSON.stringify({ id: '5', command: 'approval.list', arguments: {} }),
      ].join('\n') + '\n',
    });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 120_000, `本次运行没有挂起，用时 ${elapsed} 毫秒`);
    assertProtocolLines(result.lines);
    const list = responseOf(result.lines, '2');
    assert.equal(list.ok, true);
    const unknown = responseOf(result.lines, '3');
    assert.equal(unknown.ok, false, '未知审批请求被拒绝');
    assert.equal(unknown.error.code, 'rejected', '未知请求按 rejected 报告');
    assert.match(unknown.error.message, /没有待应答的审批请求/u, '错误信息说明请求不存在');
    const sent = responseOf(result.lines, '4');
    assert.equal(sent.ok, false, '缺少模型凭据时回合在授权之前就结束');
    assert.equal(sent.error.code, 'runtime');
    const after = responseOf(result.lines, '5');
    assert.deepEqual(after.result.pending, [], '没有遗留的待应答审批');
    assert.equal(result.code, 1, '本次运行有运行时错误，退出码为 1');
  } finally {
    releaseIndependentHome(home);
  }
});

test('断管道：stdout 读端关闭后清理并正常结束，不打印错误调用明细', { timeout: 180_000 }, async () => {
  const home = makeHome('wp36-epipe');
  const cli = new CliProcess({ home, env: TELEMETRY_OFF });
  try {
    cli.send({ id: '1', command: 'command.tree' });
    await cli.waitFor((line) => line.id === '1');
    cli.child.stdout.destroy();
    for (let index = 0; index < 20; index += 1) {
      cli.send({ id: `after-${index}`, command: 'command.tree' });
    }
    const exit = await Promise.race([
      cli.exited,
      new Promise((settle) => setTimeout(() => settle({ code: 'timeout', signal: null }), 60_000)),
    ]);
    assert.equal(exit.code, 0, `断管道之后退出码为 0（收到 ${JSON.stringify(exit)}）`);
    assert.ok(!/at .*\(.*:\d+:\d+\)/u.test(cli.stderr), `stderr 没有错误调用明细：${cli.stderr}`);
    assert.ok(!/EBADF|EPIPE|Unhandled/u.test(cli.stderr), `stderr 没有管道错误：${cli.stderr}`);
  } finally {
    cli.child.kill('SIGKILL');
    releaseIndependentHome(home);
  }
});

test('断管道：管道下游提前关闭时命令行正常结束', { timeout: 180_000 }, async () => {
  const home = makeHome('wp36-epipe2');
  try {
    const request = JSON.stringify({ id: 'tree', command: 'command.tree' });
    const command = [
      `printf '%s\\n' ${Array.from({ length: 40 }, () => `'${request}'`).join(' ')} | '${NODE}' '${CLI_ENTRY}' --json 2>epipe-stderr.log | head -1`,
      'status=${PIPESTATUS[1]}',
      'exit $status',
    ].join('\n');
    const result = await runBash(command, { cwd: home, env: { DSH_HOME: home, ...TELEMETRY_OFF } });
    assert.equal(result.code, 0, `下游关闭之后退出码为 0，stderr=${result.stderr}`);
    assert.doesNotThrow(() => JSON.parse(result.stdout.trim()), '读到的第一行仍是完整 JSON');
    const stderrPath = join(home, 'epipe-stderr.log');
    assert.ok(existsSync(stderrPath), '诊断文件存在');
    const stderrText = readFileSync(stderrPath, 'utf8');
    assert.ok(!/at .*\(.*:\d+:\d+\)/u.test(stderrText), `stderr 没有错误调用明细：${stderrText}`);
    assert.ok(!/EBADF|EPIPE/u.test(stderrText), `stderr 没有管道错误：${stderrText}`);
  } finally {
    releaseIndependentHome(home);
  }
});

test('信号：SIGINT 清理运行时子进程之后以 130 退出', { timeout: 180_000 }, async () => {
  const home = makeHome('wp36-signal');
  const cli = new CliProcess({ home, env: TELEMETRY_OFF });
  try {
    cli.send({ id: '1', command: 'session.new', arguments: {} });
    const opened = await cli.waitFor((line) => line.event === 'channel.open');
    const runtimePid = opened.pid;
    await cli.waitFor((line) => line.id === '1');
    assert.equal(await waitGone(runtimePid, 0), false, '运行时子进程在等待输入期间存在');
    cli.kill('SIGINT');
    const exit = await cli.exited;
    assert.equal(exit.code, 130, `SIGINT 之后退出码为 130（收到 ${JSON.stringify(exit)}）`);
    assert.equal(await waitGone(runtimePid, 15_000), true, '运行时子进程已经退出');
  } finally {
    cli.child.kill('SIGKILL');
    releaseIndependentHome(home);
  }
});

test('无颜色主题：非 TTY 无转义序列，TTY 可配置，窄终端重排，运行中调整宽度', { timeout: 240_000 }, async () => {
  const home = makeHome('wp36-theme');
  try {
    const plain = await runCli({ home, args: ['--format', 'text', 'scene.list'], env: TELEMETRY_OFF });
    assert.equal(plain.code, 0, `文本模式成功，stderr=${plain.stderr}`);
    assert.ok(plain.raw.length > 0, '文本模式写出可读行');
    assert.ok(plain.raw.every((line) => !line.includes('\u001B')), '非 TTY 的文本输出没有转义序列');

    const wide = await runPty({ home, cols: 120, args: ['--format', 'text', 'scene.list'], env: TELEMETRY_OFF });
    assert.ok(wide.output.includes('\u001B['), 'TTY 上默认加颜色');
    assert.ok(wide.output.includes('─'), `宽终端排成表格：${wide.output.slice(0, 200)}`);

    const noColor = await runPty({
      home,
      cols: 120,
      args: ['--format', 'text', '--color', 'never', 'scene.list'],
      env: TELEMETRY_OFF,
    });
    assert.ok(!noColor.output.includes('\u001B['), '--color never 在 TTY 上也不加颜色');

    const narrow = await runPty({
      home,
      cols: 40,
      args: ['--format', 'text', '--color', 'never', 'scene.list'],
      env: TELEMETRY_OFF,
    });
    assert.ok(narrow.output.includes('场景：sessions'), `窄终端改成单列布局：${narrow.output.slice(0, 200)}`);
    assert.ok(!narrow.output.includes('─'), '窄终端不排表格');

    const highContrast = await runPty({
      home,
      cols: 120,
      args: ['--format', 'text', '--color', 'always', '--contrast', 'high', 'scene.list'],
      env: TELEMETRY_OFF,
    });
    assert.ok(highContrast.output.includes('\u001B[1'), '高对比度用粗体');
    assert.ok(!/\u001B\[3[0-9]m/u.test(highContrast.output), '高对比度不依赖色相');

    const resized = await runPty({
      home,
      cols: 80,
      args: ['--color', 'never'],
      env: TELEMETRY_OFF,
      steps: [
        { delay: 1_500, resize: { cols: 100, rows: 30 } },
        { delay: 800, write: 'exit\n' },
      ],
    });
    assert.ok(
      resized.output.includes('终端宽度调整为 100 列'),
      `运行中调整宽度后重排：${resized.output.slice(0, 400)}`,
    );
  } finally {
    releaseIndependentHome(home);
  }
});

test('交互终端：命令补全、帮助与取消在真实 PTY 上可用', { timeout: 240_000 }, async () => {
  const home = makeHome('wp36-interactive');
  try {
    const result = await runPty({
      home,
      cols: 100,
      args: ['--color', 'never'],
      env: TELEMETRY_OFF,
      timeoutMs: 180_000,
      steps: [
        { delay: 1_500, write: 'help\n' },
        { delay: 1_200, write: 'command.co\t' },
        { delay: 600, write: ' session\n' },
        { delay: 1_500, write: 'session.new\n' },
        { delay: 10_000, write: 'session.cancel\n' },
        { delay: 2_500, write: 'exit\n' },
      ],
    });
    assert.equal(result.code, 0, `交互模式正常退出（输出 ${result.output.slice(-400)}）`);
    assert.ok(result.output.includes('ChatDSH 本机命令行'), '打印标题');
    assert.ok(result.output.includes('命令组：'), 'help 列出命令组');
    assert.ok(result.output.includes('command.complete'), `Tab 补全出完整命令标识：${result.output.slice(0, 400)}`);
    assert.ok(result.output.includes('已新建会话'), `交互模式执行了会话创建：${result.output.slice(-600)}`);
    assert.ok(result.output.includes('已请求取消'), `交互模式发出取消：${result.output.slice(-400)}`);
    assert.ok(!result.output.includes('at file://'), '没有错误调用明细');
  } finally {
    releaseIndependentHome(home);
  }
});

test('遥测：关闭与出口不可达都不改变业务结果', { timeout: 240_000 }, async () => {
  const home = makeHome('wp36-telemetry');
  try {
    const request = `${JSON.stringify({ id: '1', command: 'session.new', arguments: {} })}\n`;
    const off = await runCli({ home, input: request, env: { CHATDSH_TELEMETRY: 'off' } });
    assert.equal(off.code, 0, `关闭遥测时成功，stderr=${off.stderr}`);

    const unreachable = await runCli({
      home,
      input: request,
      env: { CHATDSH_TELEMETRY_ENDPOINT: 'http://127.0.0.1:1', CHATDSH_TELEMETRY_EXPORT_TIMEOUT: '200' },
    });
    assert.equal(unreachable.code, 0, `遥测出口不可达时业务结果不变，stderr=${unreachable.stderr}`);
    assert.equal(responseOf(unreachable.lines, '1').ok, true, '出口不可达不影响命令结果');

    const open = await runCli({ home, args: ['--json', '-e', 'status'], env: {} });
    const telemetryEntry = responseOf(open.lines, 'single').result.entries.find((entry) => entry.id === 'telemetry');
    assert.equal(telemetryEntry.value, '开启', '默认开启，且状态栏如实报告');
  } finally {
    releaseIndependentHome(home);
  }
});
