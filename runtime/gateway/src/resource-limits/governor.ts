/**
 * 控制平面的资源治理器：请求体守卫、事件流连接配额、导出与备份的有界受理、期限与清理。
 *
 * 请求体在读取之前先看声明长度，没有声明长度时按块累计，越界立刻停止读取，因此内存占用
 * 不会超过额度加最后一块。超限一律返回明确的拒绝对象，带错误码、实测值、单位与允许的处理
 * 入口。连接配额按访问会话计数，超出的连接被拒绝并指向复用现有连接。导出与备份共享同一套
 * 有界受理：并发一个、排队四项，满时明确拒绝并给出稍后重试的入口。
 *
 * 遥测的拒绝事件、计数与容量分布都在这里汇总；治理器不改变业务语义，只决定本次处理是否成立。
 * @module @chatdsh/gateway/resource-limits/governor
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ChatdshTelemetry } from '@chatdsh/core-contracts';
import {
  BoundedAdmission,
  CountedBytes,
  createDeadline,
  guardBytes,
  guardCount,
  guardDeclaredLength,
  rejectionOf,
  type ResourceRejection,
  type ResourceScope,
} from '@chatdsh/core-limits';
import { RESOURCE_SPANS, ResourceTelemetry } from './telemetry.ts';

/** 请求体读取结果。 */
export type BodyRead =
  | { readonly ok: true; readonly bytes: number; readonly body: Buffer }
  | { readonly ok: false; readonly rejection: ResourceRejection; readonly bytes: number };

/** 事件流连接准入结果。 */
export type SseAdmission =
  | { readonly ok: true; readonly connectionId: string; readonly release: () => void }
  | { readonly ok: false; readonly rejection: ResourceRejection; readonly open: number };

/** 治理器对外快照。 */
export interface GovernorSnapshot {
  /** 当前事件流连接数。 */
  readonly sseConnections: number;
  /** 当前占用配额的访问会话数。 */
  readonly sseSessions: number;
  /** 导出受理状态。 */
  readonly exportAdmission: { readonly running: number; readonly queued: number; readonly concurrency: number; readonly queueCapacity: number };
  /** 备份受理状态。 */
  readonly backupAdmission: { readonly running: number; readonly queued: number; readonly concurrency: number; readonly queueCapacity: number };
  /** 累计拒绝次数，按资源种类。 */
  readonly rejections: Readonly<Record<string, number>>;
  /** 累计通过的负载字节。 */
  readonly acceptedBytes: number;
}

/** 治理器选项。 */
export interface GovernorOptions {
  /** 遥测出口；缺省时只做限制，不发信号。 */
  readonly telemetry?: ChatdshTelemetry;
}

/** 已受理任务的取消句柄。 */
interface ActiveTask {
  readonly controller: AbortController;
}

/** 资源治理器。 */
export class ResourceGovernor {
  /** 遥测出口。 */
  readonly telemetry: ResourceTelemetry;
  private readonly sessions = new Map<string, Set<string>>();
  private readonly connections = new Map<string, ServerResponse>();
  private readonly exportAdmission: BoundedAdmission;
  private readonly backupAdmission: BoundedAdmission;
  private readonly activeTasks = new Set<ActiveTask>();
  private readonly rejectionCounts = new Map<string, number>();
  private acceptedBytes = 0;
  private connectionSeq = 0;

  constructor(options: GovernorOptions = {}) {
    this.telemetry = new ResourceTelemetry(options.telemetry);
    this.exportAdmission = new BoundedAdmission({
      kind: 'export',
      onEvent: (event) => {
        this.telemetry.gaugeInflight('export', event.running);
        this.telemetry.gaugeQueueDepth('export', event.queued);
        if (event.kind === 'rejected') this.recordRejection('export-queue', event.rejection);
      },
    });
    this.backupAdmission = new BoundedAdmission({
      kind: 'backup',
      onEvent: (event) => {
        this.telemetry.gaugeInflight('backup', event.running);
        this.telemetry.gaugeQueueDepth('backup', event.queued);
        if (event.kind === 'rejected') this.recordRejection('backup-queue', event.rejection);
      },
    });
  }

  /** 导出受理器。 */
  get exportQueue(): BoundedAdmission {
    return this.exportAdmission;
  }

  /** 备份受理器。 */
  get backupQueue(): BoundedAdmission {
    return this.backupAdmission;
  }

  /**
   * 读取受额度约束的请求体。
   *
   * 先查声明长度；没有声明长度时逐块累计，越界立即暂停读取并返回拒绝。读取期限按设计额度
   * 计算，到期返回期限拒绝。
   * @param request - 入站请求。
   * @param scope - 资源种类。
   * @returns 读取结果。
   */
  async readBody(request: IncomingMessage, scope: ResourceScope): Promise<BodyRead> {
    const span = this.telemetry.start(RESOURCE_SPANS.guard, { kind: scope, action: 'read-body' });
    const declared = declaredLengthOf(request);
    const declaredVerdict = guardDeclaredLength(scope, declared);
    if (declaredVerdict.ok === false) {
      this.recordRejection(scope, declaredVerdict.rejection);
      if (span !== undefined) this.telemetry.markRejection(span, declaredVerdict.rejection);
      span?.end();
      // 声明长度已经超限：在短期限内把对端正在发送的字节读掉并丢弃，再让调用方回答。
      // 对端一旦收到明确的拒绝就会停止上传，连接可以按正常顺序关闭。
      await drainBody(request, DRAIN_ANSWER_MS, false);
      return { ok: false, rejection: declaredVerdict.rejection, bytes: 0 };
    }

    const counter = new CountedBytes(scope);
    const chunks: Buffer[] = [];
    const deadline = createDeadline('read-timeout');
    const outcome = await this.consume(request, counter, chunks, deadline.remaining());
    span?.setAttribute('bytes', counter.bytes);
    if (outcome.kind === 'over-limit') {
      const rejection = rejectionOf(scope, counter.limit + 1);
      this.recordRejection(scope, rejection);
      if (span !== undefined) this.telemetry.markRejection(span, rejection);
      span?.end();
      await drainBody(request, DRAIN_BUDGET_MS);
      return { ok: false, rejection, bytes: counter.bytes };
    }
    if (outcome.kind === 'deadline') {
      const rejection = deadline.rejection();
      this.recordRejection(scope, rejection);
      if (span !== undefined) this.telemetry.markRejection(span, rejection);
      span?.setAttribute('error.type', 'deadline');
      span?.end();
      return { ok: false, rejection, bytes: counter.bytes };
    }
    if (outcome.kind === 'aborted') {
      span?.setAttribute('outcome', 'aborted');
      span?.end();
      return { ok: false, rejection: rejectionOf(scope, counter.bytes), bytes: counter.bytes };
    }
    this.acceptedBytes += counter.bytes;
    this.telemetry.check(scope, 'accepted', counter.bytes);
    span?.setAttribute('outcome', 'accepted');
    span?.end();
    return { ok: true, bytes: counter.bytes, body: Buffer.concat(chunks) };
  }

  /**
   * 申请一条事件流连接。
   * @param sessionKey - 访问会话标识。
   * @returns 准入结果；配额已满时为拒绝，并给出当前连接数。
   */
  admitSse(sessionKey: string): SseAdmission {
    const open = this.sessions.get(sessionKey);
    const current = open?.size ?? 0;
    const verdict = guardCount('sse-connection', current + 1);
    if (verdict.ok === false) {
      this.recordRejection('sse-connection', verdict.rejection);
      return { ok: false, rejection: verdict.rejection, open: current };
    }
    this.connectionSeq += 1;
    const connectionId = `sse-${String(this.connectionSeq)}`;
    const set = open ?? new Set<string>();
    set.add(connectionId);
    this.sessions.set(sessionKey, set);
    this.telemetry.gaugeConnections(this.connectionCount());
    return {
      ok: true,
      connectionId,
      release: () => {
        const current2 = this.sessions.get(sessionKey);
        if (current2 === undefined) return;
        current2.delete(connectionId);
        if (current2.size === 0) this.sessions.delete(sessionKey);
        this.telemetry.gaugeConnections(this.connectionCount());
      },
    };
  }

  /**
   * 登记一条事件流响应用于统一清理。
   * @param connectionId - 连接标识。
   * @param response - 响应对象。
   */
  trackSse(connectionId: string, response: ServerResponse): void {
    this.connections.set(connectionId, response);
  }

  /**
   * 注销一条事件流响应。
   * @param connectionId - 连接标识。
   */
  untrackSse(connectionId: string): void {
    this.connections.delete(connectionId);
  }

  /**
   * 受理一次导出。
   * @param work - 执行函数，收到一个中止信号。
   * @returns 受理结果。
   */
  runExport<T>(work: (signal: AbortSignal) => Promise<T>): Promise<{ ok: true; value: T; waitedMs: number } | { ok: false; rejection: ResourceRejection }> {
    return this.runBounded(this.exportAdmission, work);
  }

  /**
   * 受理一次备份。
   * @param work - 执行函数，收到一个中止信号。
   * @returns 受理结果。
   */
  runBackup<T>(work: (signal: AbortSignal) => Promise<T>): Promise<{ ok: true; value: T; waitedMs: number } | { ok: false; rejection: ResourceRejection }> {
    return this.runBounded(this.backupAdmission, work);
  }

  /**
   * 取消全部已受理任务并关闭事件流连接。
   *
   * 取消句柄中止进行中的导出与备份；连接按完成状态跳过。清理只做终止，不写业务内容。
   */
  async close(): Promise<void> {
    for (const task of this.activeTasks) task.controller.abort();
    this.activeTasks.clear();
    for (const response of this.connections.values()) {
      if (!response.writableEnded) response.end();
      if (!response.destroyed) response.destroy();
    }
    this.connections.clear();
    this.sessions.clear();
    this.telemetry.gaugeConnections(0);
  }

  /** 当前快照。 */
  snapshot(): GovernorSnapshot {
    const rejections: Record<string, number> = {};
    for (const [scope, count] of this.rejectionCounts) rejections[scope] = count;
    return {
      sseConnections: this.connectionCount(),
      sseSessions: this.sessions.size,
      exportAdmission: this.exportAdmission.snapshot(),
      backupAdmission: this.backupAdmission.snapshot(),
      rejections,
      acceptedBytes: this.acceptedBytes,
    };
  }

  /** 当前事件流连接总数。 */
  connectionCount(): number {
    let total = 0;
    for (const set of this.sessions.values()) total += set.size;
    return total;
  }

  /**
   * 写一个拒绝响应。
   *
   * 响应体带错误码、资源种类、单位、上限、实测值与允许的处理入口；限流类拒绝带
   * `Retry-After`。未读完的请求体由 {@link drainBody} 在后台丢弃，连接在期限之后关闭。
   * @param response - 响应对象。
   * @param rejection - 拒绝描述。
   * @param extra - 附加字段。
   */
  writeRejection(response: ServerResponse, rejection: ResourceRejection, extra: Record<string, unknown> = {}): void {
    if (response.writableEnded || response.destroyed) return;
    const body = JSON.stringify({
      ...extra,
      error: rejection.code,
      kind: rejection.scope,
      unit: rejection.unit,
      limit: rejection.limit,
      observed: rejection.observed,
      entry: rejection.entry,
      guidance: rejection.guidance,
    });
    const headers: Record<string, string> = {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(body)),
      'Cache-Control': 'no-store',
    };
    // 拒绝之后这条连接不再复用：请求体可能没有被读完，关闭连接才能让响应确定到达对端。
    if (rejection.status === 413) headers.Connection = 'close';
    const retryAfterMs = retryAfterOf(rejection);
    if (retryAfterMs !== undefined) headers['Retry-After'] = String(Math.ceil(retryAfterMs / 1000));
    response.writeHead(rejection.status, headers);
    response.end(body);
  }

  /** 记录一次拒绝：计数、事件与分布。 */
  recordRejection(scope: ResourceScope, rejection: ResourceRejection): void {
    this.rejectionCounts.set(scope, (this.rejectionCounts.get(scope) ?? 0) + 1);
    this.telemetry.check(scope, 'rejected', rejection.observed);
    this.telemetry.rejected(rejection);
  }

  /** 有界受理的公共实现。 */
  private async runBounded<T>(
    admission: BoundedAdmission,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<{ ok: true; value: T; waitedMs: number } | { ok: false; rejection: ResourceRejection }> {
    const task: ActiveTask = { controller: new AbortController() };
    this.activeTasks.add(task);
    try {
      const outcome = await admission.run(async () => {
        return await work(task.controller.signal);
      });
      if (outcome.ok === false) {
        this.recordRejection(admission === this.exportAdmission ? 'export-queue' : 'backup-queue', outcome.rejection);
        return { ok: false, rejection: outcome.rejection };
      }
      return outcome;
    } finally {
      this.activeTasks.delete(task);
    }
  }

  /**
   * 消费请求体。
   *
   * 逐块累计与拼接；越过额度时暂停读取并立即返回，剩余内容不再进入内存。
   * @returns 结束原因。
   */
  private consume(
    request: IncomingMessage,
    counter: CountedBytes,
    chunks: Buffer[],
    timeoutMs: number,
  ): Promise<{ kind: 'end' } | { kind: 'over-limit' } | { kind: 'deadline' } | { kind: 'aborted' }> {
    return new Promise((settle) => {
      let done = false;
      const finish = (result: { kind: 'end' } | { kind: 'over-limit' } | { kind: 'deadline' } | { kind: 'aborted' }): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        request.off('data', onData);
        request.off('end', onEnd);
        request.off('error', onError);
        request.off('aborted', onAborted);
        settle(result);
      };
      const timer = setTimeout(() => {
        request.pause();
        finish({ kind: 'deadline' });
      }, timeoutMs);
      timer.unref();
      const onData = (chunk: Buffer): void => {
        if (!counter.accept(chunk.length)) {
          request.pause();
          finish({ kind: 'over-limit' });
          return;
        }
        chunks.push(chunk);
      };
      const onEnd = (): void => finish({ kind: 'end' });
      const onError = (): void => finish({ kind: 'aborted' });
      const onAborted = (): void => finish({ kind: 'aborted' });
      request.on('data', onData);
      request.on('end', onEnd);
      request.on('error', onError);
      request.on('aborted', onAborted);
    });
  }
}

/** 读请求里声明的请求体长度。 */
export function declaredLengthOf(request: IncomingMessage): number | undefined {
  const raw = request.headers['content-length'];
  if (typeof raw !== 'string' || raw === '') return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
}

/** 拒绝之后丢弃剩余请求体的时间预算：超过预算就断开，避免超大请求长期占用连接。 */
const DRAIN_BUDGET_MS = 5000;

/** 声明长度超限时回答之前丢弃请求体的期限：在线路允许的时间内读完，读不完就断开。 */
const DRAIN_ANSWER_MS = 250;

/**
 * 丢弃尚未读取的请求体。
 *
 * 被拒绝的上传如果直接关连接，对端会写到已关闭的套接字上并看到连接错误；在线路速率允许的
 * 时间内把剩余字节读掉并丢弃，内存占用不变，对端能先拿到明确的拒绝响应。
 * @param request - 入站请求。
 * @param budgetMs - 时间预算，毫秒。
 * @param closeOnTimeout - 预算用尽时是否断开连接；回答之前的那次丢弃取假，让响应正常送完。
 */
export async function drainBody(request: IncomingMessage, budgetMs: number, closeOnTimeout = true): Promise<void> {
  await new Promise<void>((settle) => {
    const timer = setTimeout(() => {
      if (closeOnTimeout) request.destroy();
      else request.pause();
      settle();
    }, budgetMs);
    timer.unref();
    const done = (): void => {
      clearTimeout(timer);
      settle();
    };
    request.once('end', done);
    request.once('error', done);
    request.once('close', done);
    request.resume();
  });
}

/** 限流类拒绝的重试间隔。 */
function retryAfterOf(rejection: ResourceRejection): number | undefined {  if (rejection.status !== 429 && rejection.status !== 503) return undefined;
  return 1000;
}

/** 判定一帧设备负载是否超过单帧额度。 */
export function guardFrame(bytes: number): void {
  const verdict = guardBytes('device-frame-payload', bytes);
  if (verdict.ok === false) throw new Error(`${verdict.rejection.code}：设备帧 ${String(bytes)} 字节`);
}
