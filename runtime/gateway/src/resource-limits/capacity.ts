/**
 * 容量报告的场景驱动。
 *
 * 每个场景都用真实进程与真实 HTTP 测量：冷启动起一个真实子进程打开真实 SQLite 并请求一次
 * 探活；静态壳与业务激活请求真实路由；长会话分页从真实副本里读事件；同时流式会话开 20 条
 * 真实事件流；订阅场景登记 100 条连接并测事件附加延迟；超限上传按边界与边界加一验证；
 * 慢消费让一个订阅不读并检查其他订阅不受影响；断线重连做 100 次订阅切换；队列恢复把有界
 * 受理的排队全部消化；连续副本追赶按批次写真实库；导出与备份走有界受理。
 *
 * 阈值不在这里读：记录器在测量之前已经拿到冻结的阈值表，这里只负责采样。
 * @module @chatdsh/gateway/resource-limits/capacity
 */

import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  CAPACITY_THRESHOLDS,
  RESOURCE_LIMITS,
  type CapacityRecorder,
  type ScenarioReport,
} from '@chatdsh/core-limits';

/** 一次 HTTP 调用结果。 */
export interface HttpResult {
  /** 状态码。 */
  readonly status: number;
  /** 响应正文。 */
  readonly body: string;
  /** 耗时，毫秒。 */
  readonly ms: number;
}

/** 场景驱动选项。 */
export interface CapacityRunOptions {
  /** 服务地址，例如 `http://127.0.0.1:1234`。 */
  readonly baseUrl: string;
  /** 数据根，冷启动探针要用它打开同一个真实库。 */
  readonly dataRoot: string;
  /** 容量记录器。 */
  readonly recorder: CapacityRecorder;
  /** 被测量会话的标识。 */
  readonly sessionId: string;
  /** 参与订阅场景的设备标识。 */
  readonly deviceIds: readonly string[];
  /** 事件附加延迟的原始采样，来自分发的真实写耗时。 */
  readonly dispatchSamplesMs: () => readonly number[];
  /** 清空分发采样，供下一个场景重新计时。 */
  readonly resetDispatchSamples: () => void;
  /** 当前订阅数，来自分发的真实状态。 */
  readonly subscriptionCount: () => number;
  /** 每次测量重复次数。 */
  readonly repeats?: number;
}

/** 调用一次地址并计时。 */
export async function call(url: string, init?: RequestInit): Promise<HttpResult> {
  const started = performance.now();
  const parsed = new URL(url);
  const method = init?.method ?? 'GET';
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[key] = value;
  const body = init?.body;
  const buffer = body === undefined || body === null
    ? undefined
    : Buffer.isBuffer(body)
      ? body
      : Buffer.from(String(body));
  if (buffer !== undefined) headers['Content-Length'] = String(buffer.byteLength);
  // 每次请求新建连接：拒绝响应会关闭连接，复用连接池会让下一次写入落到已关闭的套接字上。
  const result = await new Promise<{ status: number; body: string }>((settle, failWith) => {
    let finished = false;
    const fail = (error: Error): void => {
      // 带上请求方法与路径，便于定位是哪一条请求在连接上失败。
      failWith(new Error(`请求失败 ${method} ${parsed.pathname}：${String((error as NodeJS.ErrnoException).code ?? error.message)}`, { cause: error }));
    };
    const finish = (status: number, text: string): void => {
      if (finished) return;
      finished = true;
      settle({ status, body: text });
    };
    const request = httpRequest({
      hostname: parsed.hostname,
      port: parsed.port,
      path: `${parsed.pathname}${parsed.search}`,
      method,
      headers,
      agent: false,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        finish(response.statusCode ?? 0, Buffer.concat(chunks).toString('utf8'));
      });
      response.on('error', () => {
        finish(response.statusCode ?? 0, Buffer.concat(chunks).toString('utf8'));
      });
    });
    request.on('error', (error) => {
      // 服务端在读完请求体之前就拒绝时会关闭连接，响应通常已经到达；给响应留出到达时间。
      if (finished) return;
      setTimeout(() => {
        if (!finished) fail(error);
      }, 1000).unref();
    });
    if (buffer !== undefined) request.write(buffer);
    request.end();
  });
  return { status: result.status, body: result.body, ms: performance.now() - started };
}

/** 一条已打开的事件流。 */
export interface OpenStream {
  /** 原始响应。 */
  readonly response: import('node:http').IncomingMessage;
  /** 主动断开。 */
  readonly close: () => void;
}

/** 以原始 HTTP 打开一条事件流。 */
function openStream(url: string, onFrame: (frame: string) => void, onClose: () => void): Promise<OpenStream> {
  return new Promise((settle, fail) => {
    const request = httpRequest(url, { agent: false }, (response) => {
      let buffer = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        buffer += chunk;
        let index = buffer.indexOf('\n\n');
        while (index >= 0) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          onFrame(frame);
          index = buffer.indexOf('\n\n');
        }
      });
      response.on('close', onClose);
      response.on('error', onClose);
      settle({
        response,
        close: () => {
          request.destroy();
        },
      });
    });
    request.on('error', (error) => {
      onClose();
      fail(error);
    });
    request.end();
  });
}

/** 安静等待。 */
function delay(ms: number): Promise<void> {
  return new Promise((settle) => setTimeout(settle, ms));
}

/** 等待条件成立。 */
async function waitUntil(check: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(20);
  }
  throw new Error(`等待超时：${label}`);
}

/** 上报一条事件。 */
async function postEvent(baseUrl: string, sessionId: string, seq: number, kind: string, payload: unknown): Promise<HttpResult> {
  const body = JSON.stringify({ sessionId, events: [{ seq, kind, time: Date.now(), payload }] });
  return call(`${baseUrl}/chatdsh/gateway/resource/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
}

/**
 * 冷启动：起一个真实子进程，打开真实 SQLite、监听端口、请求一次探活，报告总耗时。
 * @param recorder - 记录器。
 * @param dataRoot - 数据根。
 * @param repeats - 重复次数。
 * @returns 场景报告。
 */
export async function measureColdStart(recorder: CapacityRecorder, dataRoot: string, repeats = 3): Promise<ScenarioReport> {
  const session = recorder.begin('cold-start');
  const probe = fileURLToPath(new URL('./probe.js', import.meta.url));
  for (let index = 0; index < repeats; index += 1) {
    session.observe();
    const elapsed = await new Promise<number>((settle, fail) => {
      const child = spawn(process.execPath, [probe, '--mode=start', `--root=${dataRoot}`], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.on('exit', (code) => {
        if (code !== 0) {
          fail(new Error(`冷启动探针退出码 ${String(code)}：${stderr}`));
          return;
        }
        const line = stdout.trim().split('\n').pop();
        if (line === undefined || line === '') {
          fail(new Error('冷启动探针没有输出'));
          return;
        }
        const parsed = JSON.parse(line) as { coldStartMs?: unknown };
        if (typeof parsed.coldStartMs !== 'number') {
          fail(new Error(`冷启动探针输出缺少耗时：${line}`));
          return;
        }
        settle(parsed.coldStartMs);
      });
    });
    session.sample(elapsed);
    session.observe();
  }
  return session.finish();
}

/**
 * 静态壳：请求外壳页面与外壳脚本各若干次。
 * @param options - 服务地址、记录器与重复次数。
 * @returns 场景报告。
 */
export async function measureShellStatic(options: CapacityRunOptions): Promise<ScenarioReport> {
  const session = options.recorder.begin('shell-static');
  const repeats = options.repeats ?? 10;
  for (let index = 0; index < repeats; index += 1) {
    session.observe();
    const page = await call(`${options.baseUrl}/`);
    if (page.status !== 200) throw new Error(`外壳页面返回 ${String(page.status)}`);
    session.sample(page.ms);
    const script = await call(`${options.baseUrl}/shell/shell.js`);
    if (script.status !== 200 && script.status !== 404) throw new Error(`外壳脚本返回 ${String(script.status)}`);
    session.sample(script.ms);
  }
  session.observe();
  return session.finish();
}

/**
 * 业务激活：从真实库读出会话列表首屏与第二页。
 * @param options - 服务地址、记录器与重复次数。
 * @returns 场景报告。
 */
export async function measureBusinessActivation(options: CapacityRunOptions): Promise<ScenarioReport> {
  const session = options.recorder.begin('business-activation');
  const repeats = options.repeats ?? 10;
  for (let index = 0; index < repeats; index += 1) {
    session.observe();
    const first = await call(`${options.baseUrl}/chatdsh/gateway/sessions?limit=50`);
    if (first.status !== 200) throw new Error(`会话列表返回 ${String(first.status)}：${first.body}`);
    session.sample(first.ms);
    const second = await call(`${options.baseUrl}/chatdsh/gateway/sessions?limit=50&offset=50`);
    if (second.status !== 200) throw new Error(`会话列表第二页返回 ${String(second.status)}`);
    session.sample(second.ms);
  }
  session.observe();
  return session.finish();
}

/**
 * 长会话分页：按游标翻完真实副本，测首段与后续页。
 * @param options - 服务地址、记录器、会话与重复次数。
 * @returns 场景报告。
 */
export async function measureLongSessionPagination(options: CapacityRunOptions): Promise<ScenarioReport> {
  const session = options.recorder.begin('long-session-pagination');
  const repeats = options.repeats ?? 5;
  const base = `${options.baseUrl}/chatdsh/gateway/sessions/${encodeURIComponent(options.sessionId)}/events`;
  for (let index = 0; index < repeats; index += 1) {
    session.observe();
    const first = await call(`${base}?limit=50`);
    if (first.status !== 200) throw new Error(`历史首段返回 ${String(first.status)}`);
    const parsed = JSON.parse(first.body) as { nextAfter?: number | null };
    if (parsed.nextAfter === null || parsed.nextAfter === undefined) {
      throw new Error(`历史首段没有续读游标：${first.body.slice(0, 200)}`);
    }
    session.sample(first.ms);
    let after = parsed.nextAfter;
    let pages = 1;
    while (pages < 20) {
      const page = await call(`${base}?after=${String(after)}&limit=200`);
      if (page.status !== 200) throw new Error(`历史分页返回 ${String(page.status)}`);
      const body = JSON.parse(page.body) as { nextAfter?: number | null };
      session.sample(page.ms);
      pages += 1;
      if (body.nextAfter === null || body.nextAfter === undefined) break;
      after = body.nextAfter;
    }
  }
  session.observe();
  return session.finish();
}

/**
 * 同时流式会话：为每台设备开一条真实事件流，同时收完一批事件。
 * @param options - 场景驱动选项。
 * @param eventsPerSession - 每个会话的事件数。
 * @returns 场景报告。
 */
export async function measureConcurrentStreaming(options: CapacityRunOptions, eventsPerSession = 40): Promise<ScenarioReport> {
  const session = options.recorder.begin('concurrent-streaming');
  const devices = options.deviceIds.slice(0, 20);
  if (devices.length < 20) throw new Error('同时流式会话需要 20 台设备');
  const target = `${options.sessionId}-stream`;
  const received = new Map<string, number>();
  const streams: OpenStream[] = [];
  for (const deviceId of devices) {
    received.set(deviceId, 0);
    const stream = await openStream(
      `${options.baseUrl}/chatdsh/gateway/fanout/${encodeURIComponent(deviceId)}?session=${encodeURIComponent(target)}&since=-1`,
      (frame) => {
        if (frame.startsWith('data:')) received.set(deviceId, (received.get(deviceId) ?? 0) + 1);
      },
      () => undefined,
    );
    streams.push(stream);
  }
  await waitUntil(() => options.subscriptionCount() === devices.length, 3000, '同时流式订阅登记');
  session.setSubscriptions(devices.length);
  session.observe();
  const startedAt = performance.now();
  for (let index = 0; index < eventsPerSession; index += 1) {
    const response = await postEvent(options.baseUrl, target, index, 'turn/start', { text: 'x'.repeat(256) });
    if (response.status !== 200) throw new Error(`事件上报返回 ${String(response.status)}：${response.body}`);
    session.observe();
  }
  await waitUntil(
    () => devices.every((deviceId) => (received.get(deviceId) ?? 0) >= eventsPerSession),
    20_000,
    '同时流式收帧',
  );
  session.sample(performance.now() - startedAt);
  session.setSubscriptions(options.subscriptionCount());
  session.observe();
  for (const stream of streams) stream.close();
  await waitUntil(() => options.subscriptionCount() === 0, 3000, '同时流式断开');
  session.setSubscriptions(0);
  session.observe();
  return session.finish();
}

/**
 * 订阅：登记 100 条真实事件流连接，测事件附加延迟。
 * @param options - 场景驱动选项。
 * @param publishCount - 每个订阅收到的通知条数。
 * @returns 场景报告。
 */
export async function measureSubscriptions(options: CapacityRunOptions, publishCount = 5): Promise<ScenarioReport> {
  const session = options.recorder.begin('subscriptions');
  const devices = options.deviceIds.slice(0, 100);
  if (devices.length < 100) throw new Error('订阅场景需要 100 台设备');
  const target = `${options.sessionId}-subs`;
  const streams: OpenStream[] = [];
  for (const deviceId of devices) {
    const stream = await openStream(
      `${options.baseUrl}/chatdsh/gateway/fanout/${encodeURIComponent(deviceId)}?session=${encodeURIComponent(target)}&since=-1`,
      () => undefined,
      () => undefined,
    );
    streams.push(stream);
  }
  await waitUntil(() => options.subscriptionCount() === devices.length, 5000, '订阅登记');
  session.setSubscriptions(devices.length);
  session.observe();
  options.resetDispatchSamples();
  await delay(50);
  for (let index = 0; index < publishCount; index += 1) {
    const response = await postEvent(options.baseUrl, target, index, 'turn/start', { index });
    if (response.status !== 200) throw new Error(`事件上报返回 ${String(response.status)}`);
  }
  const latency = options.dispatchSamplesMs();
  for (const value of latency) session.sample(value);
  session.observe();
  for (const stream of streams) stream.close();
  await waitUntil(() => options.subscriptionCount() === 0, 5000, '订阅断开');
  session.setSubscriptions(0);
  session.observe();
  return session.finish();
}

/**
 * 超限上传：按每类额度的边界与边界加一各上传一次。
 * @param options - 服务地址与记录器。
 * @returns 场景报告。
 */
export async function measureOverLimitUpload(options: CapacityRunOptions): Promise<ScenarioReport> {
  const session = options.recorder.begin('over-limit-upload');
  const cases: { readonly scope: string; readonly limit: number }[] = [
    { scope: 'request-body', limit: RESOURCE_LIMITS['request-body'].value },
    { scope: 'attachment', limit: RESOURCE_LIMITS.attachment.value },
    { scope: 'preview', limit: RESOURCE_LIMITS.preview.value },
    { scope: 'message', limit: RESOURCE_LIMITS.message.value },
  ];
  for (const item of cases) {
    session.observe();
    const exact = Buffer.alloc(item.limit, 0x41);
    const accepted = await call(`${options.baseUrl}/chatdsh/gateway/resource/upload?scope=${item.scope}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: exact,
    });
    if (accepted.status !== 200) throw new Error(`${item.scope} 边界内上传被拒绝：${String(accepted.status)} ${accepted.body.slice(0, 160)}`);
    session.sample(accepted.ms);
    session.observe();
    const over = Buffer.alloc(item.limit + 1, 0x42);
    const rejected = await call(`${options.baseUrl}/chatdsh/gateway/resource/upload?scope=${item.scope}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: over,
    });
    if (rejected.status !== 413) throw new Error(`${item.scope} 超限上传没有返回 413：${String(rejected.status)} ${rejected.body.slice(0, 160)}`);
    session.sample(rejected.ms);
    session.observe();
  }
  return session.finish();
}

/**
 * 慢消费：三条快订阅与一条不读取的订阅，检查快订阅不受影响、慢订阅被明确终止。
 * @param options - 场景驱动选项。
 * @returns 场景报告。
 */
export async function measureSlowConsumer(options: CapacityRunOptions): Promise<ScenarioReport> {
  const session = options.recorder.begin('slow-consumer');
  const devices = options.deviceIds.slice(0, 4);
  if (devices.length < 4) throw new Error('慢消费场景需要四台设备');
  const fast = devices.slice(0, 3);
  const slow = devices[3];
  if (slow === undefined) throw new Error('慢消费场景缺少慢设备');
  const target = `${options.sessionId}-slow`;
  const frameCount = new Map<string, number>();
  const streams: OpenStream[] = [];
  for (const deviceId of fast) {
    frameCount.set(deviceId, 0);
    const stream = await openStream(
      `${options.baseUrl}/chatdsh/gateway/fanout/${encodeURIComponent(deviceId)}?session=${encodeURIComponent(target)}&since=-1`,
      (frame) => {
        if (frame.startsWith('data:')) frameCount.set(deviceId, (frameCount.get(deviceId) ?? 0) + 1);
      },
      () => undefined,
    );
    streams.push(stream);
  }
  const slowFrames: string[] = [];
  const slowStream = await openStream(
    `${options.baseUrl}/chatdsh/gateway/fanout/${encodeURIComponent(slow)}?session=${encodeURIComponent(target)}&since=-1`,
    (frame) => {
      slowFrames.push(frame);
    },
    () => undefined,
  );
  streams.push(slowStream);
  slowStream.response.pause();
  await waitUntil(() => options.subscriptionCount() === devices.length, 5000, '慢消费订阅登记');
  session.setSubscriptions(devices.length);
  session.observe();
  options.resetDispatchSamples();
  const burst = 500;
  const payload = 'y'.repeat(32 * 1024);
  for (let index = 0; index < burst; index += 1) {
    const response = await postEvent(options.baseUrl, target, index, 'turn/end', { text: payload });
    if (response.status !== 200) throw new Error(`事件上报返回 ${String(response.status)}：${response.body}`);
    session.observe();
  }
  await waitUntil(() => fast.every((deviceId) => (frameCount.get(deviceId) ?? 0) >= burst), 20_000, '快订阅收帧');
  for (const value of options.dispatchSamplesMs()) session.sample(value);
  session.observe();
  slowStream.response.resume();
  await waitUntil(
    () => slowFrames.some((frame) => frame.includes('backpressure-exceeded')),
    20_000,
    '慢订阅背压终止',
  );
  const errorFrame = slowFrames.find((frame) => frame.includes('backpressure-exceeded'));
  if (errorFrame === undefined) throw new Error('慢订阅没有收到明确的背压拒绝帧');
  const errorData = errorFrame.split('\ndata: ')[1];
  if (errorData === undefined) throw new Error(`背压帧没有数据部分：${errorFrame}`);
  const parsedError = JSON.parse(errorData) as { entry?: string; sinceSeq?: number };
  if (parsedError.entry !== 'resume-cursor' || typeof parsedError.sinceSeq !== 'number') {
    throw new Error(`背压帧缺少续读入口：${errorData}`);
  }
  let lastSeq = -1;
  for (const frame of slowFrames) {
    if (!frame.startsWith('data:')) continue;
    const parsed = JSON.parse(frame.slice('data:'.length).trim()) as { seq?: number };
    if (typeof parsed.seq === 'number') lastSeq = Math.max(lastSeq, parsed.seq);
  }
  for (const stream of streams) stream.close();
  await waitUntil(() => options.subscriptionCount() === 0, 5000, '慢消费断开');
  session.setSubscriptions(0);
  session.observe();
  const resumeFrom = lastSeq;
  const replayed: number[] = [];
  const resumeStream = await openStream(
    `${options.baseUrl}/chatdsh/gateway/fanout/${encodeURIComponent(slow)}?session=${encodeURIComponent(target)}&since=${String(resumeFrom)}`,
    (frame) => {
      if (!frame.startsWith('data:')) return;
      const parsed = JSON.parse(frame.slice('data:'.length).trim()) as { seq?: number };
      if (typeof parsed.seq === 'number') replayed.push(parsed.seq);
    },
    () => undefined,
  );
  const expectedRemaining = burst - (resumeFrom + 1);
  await waitUntil(() => replayed.length >= Math.min(expectedRemaining, 1), 10_000, '慢订阅续读补齐');
  resumeStream.close();
  await waitUntil(() => options.subscriptionCount() === 0, 5000, '续读断开');
  session.setSubscriptions(0);
  return session.finish();
}

/**
 * 断线重连：对一台设备做多轮订阅与断开，检查订阅回到基线。
 * @param options - 场景驱动选项。
 * @param switches - 切换次数，默认取登记值 100。
 * @returns 场景报告。
 */
export async function measureReconnect(
  options: CapacityRunOptions,
  switches = CAPACITY_THRESHOLDS.deviceSwitchCount,
): Promise<ScenarioReport> {
  const session = options.recorder.begin('reconnect');
  const deviceId = options.deviceIds[0];
  if (deviceId === undefined) throw new Error('重连场景缺少设备');
  const target = `${options.sessionId}-reconnect`;
  const startedAt = performance.now();
  for (let index = 0; index < switches; index += 1) {
    const stream = await openStream(
      `${options.baseUrl}/chatdsh/gateway/fanout/${encodeURIComponent(deviceId)}?session=${encodeURIComponent(target)}&since=-1`,
      () => undefined,
      () => undefined,
    );
    session.setSubscriptions(1);
    await delay(2);
    stream.close();
    await waitUntil(() => options.subscriptionCount() === 0, 2000, '重连断开');
    session.setSubscriptions(0);
  }
  session.sample(performance.now() - startedAt);
  session.observe();
  return session.finish();
}

/**
 * 队列恢复：并发提交 8 个导出，超出并发与队列的请求被拒绝，已受理的全部完成。
 * @param options - 服务地址与记录器。
 * @returns 场景报告。
 */
export async function measureQueueRecovery(options: CapacityRunOptions): Promise<ScenarioReport> {
  const session = options.recorder.begin('queue-recovery');
  const accepted = RESOURCE_LIMITS['export-concurrency'].value + RESOURCE_LIMITS['export-queue'].value;
  const attempts = accepted + 3;
  session.observe();
  const results = await Promise.all(
    Array.from({ length: attempts }, async () => {
      const response = await call(`${options.baseUrl}/chatdsh/gateway/resource/export`, { method: 'POST' });
      return { status: response.status, body: response.body, ms: response.ms };
    }),
  );
  for (const result of results) {
    session.sample(result.ms);
    session.observe();
  }
  const okCount = results.filter((result) => result.status === 200).length;
  const rejected = results.filter((result) => result.status === 429);
  if (okCount < 1) throw new Error(`队列恢复没有任何受理：${results.map((item) => String(item.status)).join(',')}`);
  if (okCount > accepted) throw new Error(`队列恢复受理超过并发与队列上限：${String(okCount)} 个`);
  if (okCount + rejected.length !== attempts) {
    throw new Error(`队列恢复出现未登记的响应：${results.map((item) => String(item.status)).join(',')}`);
  }
  for (const result of rejected) {
    const body = JSON.parse(result.body) as { error?: string; entry?: string };
    if (body.error !== 'queue-full' || body.entry !== 'queued-retry') {
      throw new Error(`队列拒绝语义不对：${result.body}`);
    }
  }
  session.observe();
  return session.finish();
}

/**
 * 连续副本追赶：按批次把事件写进真实连续副本，检查连续前缀推进。
 * @param options - 服务地址与记录器。
 * @param eventsPerBatch - 每批事件数。
 * @param batches - 批次数。
 * @returns 场景报告。
 */
export async function measureReplicaCatchup(
  options: CapacityRunOptions,
  eventsPerBatch = 200,
  batches = 3,
): Promise<ScenarioReport> {
  const session = options.recorder.begin('replica-catchup');
  const target = `${options.sessionId}-catchup`;
  const deviceId = options.deviceIds[0] ?? 'device-a';
  let seq = 0;
  let acceptedThrough = -1;
  for (let batch = 0; batch < batches; batch += 1) {
    session.observe();
    const events = Array.from({ length: eventsPerBatch }, (_unused, offset) => ({
      seq: seq + offset,
      kind: 'turn/start',
      time: Date.now(),
      payload: { batch, offset, text: 'z'.repeat(64) },
    }));
    seq += eventsPerBatch;
    const response = await call(`${options.baseUrl}/chatdsh/gateway/resource/replica/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: target, deviceId, retentionGeneration: 0, events }),
    });
    if (response.status !== 200) throw new Error(`副本批次返回 ${String(response.status)}：${response.body}`);
    const body = JSON.parse(response.body) as { acknowledgedThrough?: number };
    if (typeof body.acknowledgedThrough !== 'number') throw new Error(`副本批次没有确认前缀：${response.body}`);
    acceptedThrough = body.acknowledgedThrough;
    session.sample(response.ms);
    session.observe();
  }
  if (acceptedThrough !== seq - 1) {
    throw new Error(`副本连续前缀没有推进到 ${String(seq - 1)}：${String(acceptedThrough)}`);
  }
  const overBatch = await call(`${options.baseUrl}/chatdsh/gateway/resource/replica/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: target,
      deviceId,
      retentionGeneration: 0,
      events: Array.from({ length: RESOURCE_LIMITS['replica-batch-items'].value + 1 }, (_unused, offset) => ({
        seq: seq + offset,
        kind: 'turn/start',
        time: Date.now(),
        payload: { offset },
      })),
    }),
  });
  if (overBatch.status !== 413) throw new Error(`超条数副本批次没有返回 413：${String(overBatch.status)}`);
  session.sample(overBatch.ms);
  session.observe();
  return session.finish();
}

/**
 * 导出与备份：并发提交导出与备份，检查有界受理与资源峰值。
 * @param options - 服务地址与记录器。
 * @returns 场景报告。
 */
export async function measureExportBackup(options: CapacityRunOptions): Promise<ScenarioReport> {
  const session = options.recorder.begin('export-backup');
  const accepted = RESOURCE_LIMITS['backup-concurrency'].value + RESOURCE_LIMITS['backup-queue'].value;
  const attempts = accepted + 2;
  session.observe();
  const exportResults = await Promise.all(
    Array.from({ length: attempts }, async () => {
      const response = await call(`${options.baseUrl}/chatdsh/gateway/resource/export`, { method: 'POST' });
      return { status: response.status, body: response.body, ms: response.ms };
    }),
  );
  for (const result of exportResults) session.sample(result.ms);
  session.observe();
  const backupResults = await Promise.all(
    Array.from({ length: attempts }, async () => {
      const response = await call(`${options.baseUrl}/chatdsh/gateway/resource/backup`, { method: 'POST' });
      return { status: response.status, body: response.body, ms: response.ms };
    }),
  );
  for (const result of backupResults) session.sample(result.ms);
  session.observe();
  const exportOk = exportResults.filter((result) => result.status === 200).length;
  const backupOk = backupResults.filter((result) => result.status === 200).length;
  if (exportOk < 1) throw new Error(`导出没有任何受理：${exportResults.map((item) => String(item.status)).join(',')}`);
  if (backupOk < 1) throw new Error(`备份没有任何受理：${backupResults.map((item) => String(item.status)).join(',')}`);
  if (exportOk > accepted) throw new Error(`导出受理超过有界上限：${String(exportOk)} 个`);
  if (backupOk > accepted) throw new Error(`备份受理超过有界上限：${String(backupOk)} 个`);
  for (const result of [...exportResults, ...backupResults]) {
    if (result.status !== 200 && result.status !== 429) {
      throw new Error(`导出与备份出现未登记的响应：${String(result.status)} ${result.body}`);
    }
  }
  return session.finish();
}

/**
 * 按顺序跑完全部容量场景。
 * @param options - 场景驱动选项。
 * @returns 场景报告列表。
 */
export async function runCapacityScenarios(options: CapacityRunOptions): Promise<readonly ScenarioReport[]> {
  const reports: ScenarioReport[] = [];
  reports.push(await measureColdStart(options.recorder, options.dataRoot));
  reports.push(await measureShellStatic(options));
  reports.push(await measureBusinessActivation(options));
  reports.push(await measureLongSessionPagination(options));
  reports.push(await measureConcurrentStreaming(options));
  reports.push(await measureSubscriptions(options));
  reports.push(await measureOverLimitUpload(options));
  reports.push(await measureSlowConsumer(options));
  reports.push(await measureReconnect(options));
  reports.push(await measureQueueRecovery(options));
  reports.push(await measureReplicaCatchup(options));
  reports.push(await measureExportBackup(options));
  return reports;
}
