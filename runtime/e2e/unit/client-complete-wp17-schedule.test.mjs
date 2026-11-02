// WP17 验收：设备定时任务的 Remote 适配包。
//
// 用真实的 Cordis 上下文装配存储、会话注册表、agent 注册表、本机 HTTP 服务与原会话的
// 定时宿主；适配包的真实实例注册同源路径，任务全部落在 `ctx.schedule` 里。断言列出、
// 建立、编辑、取消与删除的真实结果，时间方式与 IANA 时区的计算，跨会话不复制任务，
// 以及适配包本身不建立任何定时器。
//
// 运行：node --test e2e/unit/client-complete-wp17-schedule.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';
import { ensureDeps } from '../lib/ensure-deps.mjs';

const RUNTIME = resolve(import.meta.dirname, '../..');
const REPO = resolve(RUNTIME, '..');
ensureDeps(RUNTIME);
ensureDeps(resolve(REPO, 'dsh-adapter'));
ensureBuilt();

/** 构建定时任务适配包的 TypeScript 产物，多个测试文件同时运行时串行。 */
function ensureBuilt() {
  const packageDir = join(RUNTIME, 'packages/host/schedule-ui');
  const ready = () => existsSync(join(packageDir, 'lib/index.js'));
  if (ready()) return;
  const lock = join(RUNTIME, '.verify', 'wp17-schedule-build.lock');
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
    execFileSync(join(RUNTIME, 'node_modules/.bin/tsc'), ['-b', join(packageDir, 'tsconfig.json')], { cwd: RUNTIME, stdio: 'inherit' });
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

const { Context } = await import('@deepseek-ai/cordis');
const { default: Storage } = await import('@deepseek-ai/dsh-storage');
const json = await import('@deepseek-ai/dsh-storage-json');
const domainPlugin = await import('@deepseek-ai/dsh-storage-domain');
const { default: SessionPlugin } = await import('@deepseek-ai/dsh-session');
const { default: SessionProjectionRegistry } = await import('@deepseek-ai/dsh-session-projection');
const { default: WebServer } = await import('@deepseek-ai/dsh-host-webserver');
const { default: AgentRegistry } = await import('@deepseek-ai/dsh-agent');
const { default: ScheduleService } = await import('@deepseek-ai/dsh-schedule');
const { remoteMethods } = await import('@deepseek-ai/dsh-typert-protocol');
const { ChatdshScheduleService, SCHEDULES_PATH } = await import('../../packages/host/schedule-ui/lib/index.js');
const { createTelemetryClient } = await import('../../packages/core/diagnostics/lib/client.js');
const { defaultTelemetryConfig } = await import('../../packages/core/diagnostics/lib/config.js');

/** 等待插件树激活。 */
function settle(ms = 800) {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * 装配一套真实的运行时上下文。
 * @param {{ root: string, telemetry?: object }} options 数据根与可选遥测客户端。
 * @returns {Promise<{ ctx: any, origin: string }>} 上下文与同源地址。
 */
async function openStack({ root, telemetry }) {
  const ctx = new Context();
  ctx.plugin(Storage);
  ctx.plugin(json, { root: join(root, 'storages') });
  ctx.plugin(domainPlugin, { backend: 'json' });
  ctx.plugin(SessionProjectionRegistry);
  ctx.plugin(SessionPlugin);
  ctx.plugin(AgentRegistry);
  ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
  await settle(1500);
  // 定时宿主用声明了所需服务的上下文构造；任务全部未来发生，投递相关的依赖不参与本测试。
  let scheduleCtx;
  ctx.inject(['agents', 'sessions', 'storageDomain'], (scoped) => { scheduleCtx = scoped; });
  await settle(300);
  new ScheduleService(scheduleCtx, {});
  await settle(800);
  if (telemetry !== undefined) {
    ctx.provide('chatdshTelemetry');
    ctx.set('chatdshTelemetry', telemetry);
  }
  ctx.plugin(ChatdshScheduleService);
  await settle(1200);
  return { ctx, origin: ctx.webServer.getOrigin() };
}

/** 发一次真实的 HTTP 请求。 */
async function call(origin, path, init = {}) {
  const response = await fetch(`${origin}${path}`, {
    ...init,
    headers: {
      ...(init.method === undefined || init.method === 'GET' ? {} : { 'x-chatdsh-csrf': '1' }),
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...init.headers,
    },
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? undefined : JSON.parse(text) };
}

/** 按指定时区格式化一个时刻的本地钟点。 */
function clockIn(zone, epochMs) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(epochMs));
}

/** 按指定时区格式化一个时刻的星期。 */
function weekdayIn(zone, epochMs) {
  return new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short' }).format(new Date(epochMs));
}

/** 起一个真实接收 OTLP/HTTP 请求的收集器。 */
async function startOtlpReceiver() {
  const records = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      records.push({ path: request.url ?? '', body: Buffer.concat(chunks).toString('utf8') });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{}');
    });
  });
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    records,
    async close() {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    },
  };
}

test('真实 Cordis 上下文：列出、建立、编辑、取消与删除原会话定时任务', { timeout: 180_000 }, async () => {
  const home = allocateIndependentHome('wp17-schedule');
  const previousHome = process.env.DSH_HOME;
  const root = join(home, 'runtime');
  mkdirSync(join(root, 'workspace'), { recursive: true });
  process.env.DSH_HOME = root;
  let stack;
  try {
    stack = await openStack({ root });
    const { ctx, origin } = stack;
    ctx.sessions.create('session-wp17', { meta: { cwd: join(root, 'workspace') } });
    ctx.sessions.create('session-wp17-other', { meta: { cwd: join(root, 'workspace') } });

    // 空列表。
    const empty = await call(origin, `${SCHEDULES_PATH}?sessionId=session-wp17`);
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body, { schedules: [] });

    // 建立每日任务：时区照原样保存，下次发生时刻由运行时计算。
    const daily = await call(origin, SCHEDULES_PATH, {
      method: 'POST',
      body: JSON.stringify({
        sessionId: 'session-wp17',
        name: '每日设计检查',
        prompt: '核对客户端设计规范与当前实现。',
        spec: { kind: 'daily', time: '02:30', timeZone: 'America/New_York' },
        enabled: true,
      }),
    });
    assert.equal(daily.status, 201, JSON.stringify(daily.body));
    const dailyView = daily.body;
    assert.match(dailyView.scheduleId, /^schedule-/);
    assert.equal(dailyView.sessionId, 'session-wp17');
    assert.equal(dailyView.name, '每日设计检查');
    assert.deepEqual(dailyView.spec, { kind: 'daily', time: '02:30', timeZone: 'America/New_York' });
    assert.equal(dailyView.enabled, true);
    assert.equal(typeof dailyView.nextRunAt, 'number');
    assert.equal(clockIn('America/New_York', dailyView.nextRunAt), '02:30', '下次发生时刻落在指定时区的本地钟点');
    const catalogAfterCreate = await ctx.schedule.catalog();
    assert.equal(catalogAfterCreate.length, 1, '任务落在原会话的定时宿主里');
    assert.equal(String(catalogAfterCreate[0].id), dailyView.scheduleId);
    assert.equal(Date.parse(catalogAfterCreate[0].scheduledAt), dailyView.nextRunAt, '下次发生时刻取自运行时');

    // 列表返回同一条任务。
    const listed = await call(origin, `${SCHEDULES_PATH}?sessionId=session-wp17`);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.schedules.length, 1);
    assert.equal(listed.body.schedules[0].scheduleId, dailyView.scheduleId);

    // 编辑名称只改名称，不重置发生时刻。
    const renamed = await call(origin, SCHEDULES_PATH, {
      method: 'PUT',
      body: JSON.stringify({
        sessionId: 'session-wp17',
        scheduleId: dailyView.scheduleId,
        name: '每日设计复核',
        prompt: '核对客户端设计规范与当前实现，报告验收条件。',
        spec: dailyView.spec,
        enabled: true,
      }),
    });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.equal(renamed.body.scheduleId, dailyView.scheduleId);
    assert.equal(renamed.body.name, '每日设计复核');
    assert.equal(renamed.body.nextRunAt, dailyView.nextRunAt, '只改名称时下次发生时刻不变');

    // 编辑时间方式：换成每周一与周日 21:00，时区 Asia/Shanghai。
    const weekly = await call(origin, SCHEDULES_PATH, {
      method: 'PUT',
      body: JSON.stringify({
        sessionId: 'session-wp17',
        scheduleId: dailyView.scheduleId,
        name: '每周设计复核',
        prompt: '核对客户端设计规范与当前实现。',
        spec: { kind: 'weekly', weekdays: [7, 1], time: '21:00', timeZone: 'Asia/Shanghai' },
        enabled: true,
      }),
    });
    assert.equal(weekly.status, 200, JSON.stringify(weekly.body));
    assert.deepEqual(weekly.body.spec, { kind: 'weekly', weekdays: [1, 7], time: '21:00', timeZone: 'Asia/Shanghai' });
    assert.equal(clockIn('Asia/Shanghai', weekly.body.nextRunAt), '21:00');
    assert.ok(['Mon', 'Sun'].includes(weekdayIn('Asia/Shanghai', weekly.body.nextRunAt)));
    const weeklyCatalog = await ctx.schedule.catalog();
    assert.equal(weeklyCatalog[0].kind, 'weekly');
    assert.deepEqual(weeklyCatalog[0].weekdays, [1, 7]);

    // 取消：任务不再发生，记录随删除一起离开。
    const cancelled = await call(origin, SCHEDULES_PATH, {
      method: 'PUT',
      body: JSON.stringify({
        sessionId: 'session-wp17',
        scheduleId: dailyView.scheduleId,
        name: '每周设计复核',
        prompt: '核对客户端设计规范与当前实现。',
        spec: weekly.body.spec,
        enabled: false,
      }),
    });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal(cancelled.body.enabled, false);
    assert.equal(cancelled.body.nextRunAt, undefined);
    assert.deepEqual(await ctx.schedule.list({ sessionId: 'session-wp17' }), [], '取消之后运行时不再持有该任务');

    // 固定间隔、单次与 cron。
    const interval = await call(origin, SCHEDULES_PATH, {
      method: 'POST',
      body: JSON.stringify({ sessionId: 'session-wp17', name: '间隔提醒', prompt: '看一次构建结果', spec: { kind: 'interval', everySeconds: 90, timeZone: 'Asia/Shanghai' }, enabled: true }),
    });
    assert.equal(interval.status, 201, JSON.stringify(interval.body));
    assert.ok(Math.abs(interval.body.nextRunAt - (Date.now() + 90_000)) < 5_000, '固定间隔按建立时刻锚定');
    const once = await call(origin, SCHEDULES_PATH, {
      method: 'POST',
      body: JSON.stringify({ sessionId: 'session-wp17', name: '单次提醒', prompt: '看一次发布结果', spec: { kind: 'once', at: Date.now() + 3_600_000, timeZone: 'Asia/Shanghai' }, enabled: true }),
    });
    assert.equal(once.status, 201, JSON.stringify(once.body));
    assert.equal(once.body.spec.kind, 'once');
    assert.equal(once.body.nextRunAt, once.body.spec.at);
    const immediate = await call(origin, SCHEDULES_PATH, {
      method: 'POST',
      body: JSON.stringify({ sessionId: 'session-wp17', name: '立刻提醒', prompt: '马上看一次结果', spec: { kind: 'once', at: Date.now() - 1000, timeZone: 'Asia/Shanghai' }, enabled: true }),
    });
    assert.equal(immediate.status, 201, JSON.stringify(immediate.body), '已经过去的单次时刻按立即发生处理');
    assert.ok(immediate.body.nextRunAt <= Date.now() + 2000, '立即发生的任务在最近一秒内到期');
    await ctx.schedule.delete({ sessionId: 'session-wp17', id: (await ctx.schedule.list({ sessionId: 'session-wp17' })).find((record) => record.title === '立刻提醒').id });
    const cron = await call(origin, SCHEDULES_PATH, {
      method: 'POST',
      body: JSON.stringify({ sessionId: 'session-wp17', name: 'cron 提醒', prompt: '看一次定时结果', spec: { kind: 'cron', expression: '*/15 9-10 * * *', timeZone: 'Asia/Shanghai' }, enabled: true }),
    });
    assert.equal(cron.status, 201, JSON.stringify(cron.body));
    assert.equal(cron.body.spec.expression, '*/15 9-10 * * *');
    const cronClock = clockIn('Asia/Shanghai', cron.body.nextRunAt);
    assert.ok(['09', '10'].includes(cronClock.slice(0, 2)), `cron 的下次发生落在表达式允许的钟点：${cronClock}`);
    assert.ok(['00', '15', '30', '45'].includes(cronClock.slice(3, 5)), `cron 的下次发生落在表达式允许的分钟：${cronClock}`);

    // 字段校验与互斥时间方式。
    const rejections = [
      [{ spec: { kind: 'interval', everySeconds: 30, timeZone: 'Asia/Shanghai' } }, 400],
      [{ spec: { kind: 'weekly', weekdays: [1, 1], time: '09:00', timeZone: 'Asia/Shanghai' } }, 400],
      [{ spec: { kind: 'daily', time: '09:00', timeZone: 'Mars/Olympus' } }, 400],
      [{ spec: { kind: 'cron', expression: '61 9 * * *', timeZone: 'Asia/Shanghai' } }, 400],
      [{ spec: { kind: 'cron', expression: '0 9 * *', timeZone: 'Asia/Shanghai' } }, 400],
      [{ name: '   ' }, 400],
      [{ prompt: '' }, 400],
      [{ enabled: false }, 400],
      [{ sessionId: 'session-missing' }, 404],
    ];
    for (const [patch, status] of rejections) {
      const attempt = await call(origin, SCHEDULES_PATH, {
        method: 'POST',
        body: JSON.stringify({
          sessionId: 'session-wp17',
          name: '校验用例',
          prompt: '校验时间方式与字段',
          spec: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' },
          enabled: true,
          ...patch,
        }),
      });
      assert.equal(attempt.status, status, `${JSON.stringify(patch)} 的应答状态：${JSON.stringify(attempt.body)}`);
      assert.ok(typeof attempt.body.error === 'string' && attempt.body.error !== '');
    }

    // 写操作需要同源令牌。
    const noCsrf = await fetch(`${origin}${SCHEDULES_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-wp17', name: '无令牌', prompt: '写操作', spec: { kind: 'daily', time: '09:00', timeZone: 'UTC' }, enabled: true }),
    });
    assert.equal(noCsrf.status, 403);
    assert.equal((await noCsrf.json()).error, 'permission-denied');

    // 另一条会话没有任务：跨设备继续产生的新会话不会复制定时任务。
    const forkList = await call(origin, `${SCHEDULES_PATH}?sessionId=session-wp17-other`);
    assert.equal(forkList.status, 200);
    assert.deepEqual(forkList.body.schedules, []);

    // 删除：任务离开运行时，再次删除明确失败。
    const recorded = await ctx.schedule.list({ sessionId: 'session-wp17' });
    const target = recorded.find((record) => record.title === 'cron 提醒');
    assert.ok(target !== undefined);
    const removed = await call(origin, `${SCHEDULES_PATH}?sessionId=session-wp17&scheduleId=${String(target.id)}`, { method: 'DELETE' });
    assert.equal(removed.status, 204);
    const afterRemove = await ctx.schedule.list({ sessionId: 'session-wp17' });
    assert.equal(afterRemove.some((record) => String(record.id) === String(target.id)), false);
    const removedAgain = await call(origin, `${SCHEDULES_PATH}?sessionId=session-wp17&scheduleId=${String(target.id)}`, { method: 'DELETE' });
    assert.equal(removedAgain.status, 404);

    // Remote 方法：同一套实现，五个方法都注册在真实的服务标记里。
    const methods = remoteMethods(ctx.chatdshSchedules).map((marker) => marker.method).sort();
    for (const expected of ['list', 'create', 'update', 'cancel', 'remove']) {
      assert.ok(methods.includes(expected), `缺少 Remote 方法 ${expected}：${methods.join('、')}`);
    }
    const remoteCreated = await ctx.chatdshSchedules.create({
      sessionId: 'session-wp17',
      name: 'Remote 建立',
      prompt: '通过 Remote 方法建立',
      spec: { kind: 'daily', time: '08:00', timeZone: 'Asia/Shanghai' },
      enabled: true,
    });
    assert.equal(remoteCreated.name, 'Remote 建立');
    const remoteListed = await ctx.chatdshSchedules.list('session-wp17');
    assert.ok(remoteListed.some((view) => view.scheduleId === remoteCreated.scheduleId));
    const remoteCancelled = await ctx.chatdshSchedules.cancel({ sessionId: 'session-wp17', scheduleId: remoteCreated.scheduleId });
    assert.equal(remoteCancelled.enabled, false);
    assert.equal((await ctx.schedule.list({ sessionId: 'session-wp17' })).some((record) => String(record.id) === remoteCreated.scheduleId), false);

    // 适配包自己不建立定时器，也不持有任务副本。
    const library = readFileSync(join(RUNTIME, 'packages/host/schedule-ui/lib/index.js'), 'utf8');
    assert.equal(/setInterval|setTimeout/.test(library), false, '适配包不建立定时器');
    const owned = (await ctx.schedule.catalog()).map((entry) => String(entry.id));
    assert.equal(owned.length, 2, '任务只剩运行时持有的两条');
    await ctx.schedule.delete({ sessionId: 'session-wp17', id: (await ctx.schedule.list({ sessionId: 'session-wp17' }))[0].id });
    const afterRuntimeDelete = await ctx.chatdshSchedules.list('session-wp17');
    assert.equal(afterRuntimeDelete.length, owned.length - 1, '运行时删除之后适配包立即反映');
  } finally {
    if (stack !== undefined) await stack.ctx.fiber.dispose();
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    releaseIndependentHome(home);
  }
});

test('遥测：列出、建立与失败分支写出远端调用 span、计数与错误码', { timeout: 120_000 }, async () => {
  const home = allocateIndependentHome('wp17-schedule-telemetry');
  const previousHome = process.env.DSH_HOME;
  const root = join(home, 'runtime');
  mkdirSync(join(root, 'workspace'), { recursive: true });
  process.env.DSH_HOME = root;
  const receiver = await startOtlpReceiver();
  let telemetry;
  let stack;
  try {
    telemetry = createTelemetryClient({
      config: defaultTelemetryConfig({
        endpoint: receiver.endpoint,
        surface: 'runtime',
        exportIntervalMs: 2000,
        exportIntervalMsMetrics: 3000,
        exportTimeoutMs: 500,
      }),
      component: '@chatdsh/host-schedule-ui',
      env: { CHATDSH_TELEMETRY: 'on' },
    });
    stack = await openStack({ root, telemetry });
    const { ctx, origin } = stack;
    ctx.sessions.create('session-wp17-telemetry', { meta: { cwd: join(root, 'workspace') } });

    const created = await call(origin, SCHEDULES_PATH, {
      method: 'POST',
      body: JSON.stringify({ sessionId: 'session-wp17-telemetry', name: '遥测提醒', prompt: '核对遥测信号', spec: { kind: 'daily', time: '07:30', timeZone: 'Asia/Shanghai' }, enabled: true }),
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const listed = await call(origin, `${SCHEDULES_PATH}?sessionId=session-wp17-telemetry`);
    assert.equal(listed.status, 200);
    const badRequest = await call(origin, SCHEDULES_PATH, {
      method: 'POST',
      body: JSON.stringify({ sessionId: 'session-wp17-telemetry', name: '校验失败', prompt: '校验失败', spec: { kind: 'interval', everySeconds: 30, timeZone: 'Asia/Shanghai' }, enabled: true }),
    });
    assert.equal(badRequest.status, 400);

    await telemetry.flush(5000);
    const traces = receiver.records.filter((item) => item.path.includes('/v1/traces')).map((item) => item.body);
    assert.ok(
      traces.some((body) => body.includes('chatdsh.runtime.remote.call') && body.includes('"create"') && body.includes('"ok"')),
      `建立写出远端调用 span：${receiver.records.map((item) => item.path).join(' ')}`,
    );
    assert.ok(traces.some((body) => body.includes('chatdsh.runtime.remote.call') && body.includes('"list"')), '列出写出远端调用 span');
    assert.ok(traces.some((body) => body.includes('"failed"') && body.includes('request-invalid')), '失败分支写出错误码');
    const metrics = receiver.records.filter((item) => item.path.includes('/v1/metrics')).map((item) => item.body);
    assert.ok(metrics.some((body) => body.includes('chatdsh_remote_calls_total')), '调用计数已导出');
    assert.ok(metrics.some((body) => body.includes('chatdsh_remote_call_duration_seconds')), '调用耗时已导出');
    assert.ok(metrics.some((body) => body.includes('error_code') && body.includes('request-invalid')), '失败分支按错误码计数');
    const payloads = receiver.records.map((item) => item.body).join('\n');
    assert.equal(payloads.includes('核对遥测信号'), false, '遥测里没有提醒文本');
    assert.equal(payloads.includes('session-wp17-telemetry'), false, '指标与 span 里没有会话标识');
  } finally {
    if (stack !== undefined) await stack.ctx.fiber.dispose();
    if (telemetry !== undefined) await telemetry.shutdown();
    await receiver.close();
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    releaseIndependentHome(home);
  }
});
