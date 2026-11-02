/**
 * 设备侧连续补传。
 *
 * 事件先进入权威日志，再由这里登记意图并成批上报。扫描以权威日志为准：启动与重连时
 * 枚举全部已存储会话（包含未打开的冷会话），按已确认的连续前缀重读并补齐；正文从不驻留
 * 在内存队列里，意图只保存序号，因此超出内存上限的积压仍然完整保留在日志里。
 *
 * 接收端确认之后才推进本地游标；缺口把游标退回服务端要求的位置重读，冲突与已清理代次
 * 停止该会话并保留意图，等待人工处理或显式重新获取。这条通路只读取已提交日志，与用户
 * 离线消息发送不共用队列。
 * @module @chatdsh/host-push/continuity
 */

import {
  SessionPersistenceNotFoundError,
  type SessionEvent,
  type SessionId,
  type SessionPersistence,
} from '@chatdsh/adapter';
import { NODE_HEADERS, type ChatdshTelemetry, type TelemetrySpan } from '@chatdsh/core-contracts';
import { ReplicaIntentStore } from './intents.ts';

/** 上报路由。 */
export const REPLICA_PUSH_PATH = '/chatdsh/gateway/replica';

/** 保留策略路由。 */
export const REPLICA_RETENTION_PATH = '/chatdsh/gateway/replica/retention';

/** 单批最多事件条数。 */
export const BATCH_LIMIT = 256;

/** 单批最多正文字节数。 */
export const BATCH_BYTES = 1024 * 1024;

/** 重试间隔；到达末项后保持在末项。 */
export const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 30000] as const;

/** 一次会话同步的结论。 */
export type ReplicaSyncOutcome =
  | 'idle'
  | 'pushed'
  | 'duplicate'
  | 'gap'
  | 'conflict'
  | 'stale'
  | 'unauthorized'
  | 'unreachable';

/** 一次会话同步的结果。 */
export interface ReplicaSessionSync {
  readonly sessionId: string;
  readonly outcome: ReplicaSyncOutcome;
  readonly acknowledgedThrough: number;
  readonly appended: number;
  readonly duplicates: number;
  /** 本会话仍未确认的事件条数。 */
  readonly remaining: number;
}

/** 控制平面返回的会话游标。 */
export interface RemoteReplicaCursor {
  readonly retentionGeneration: number;
  readonly retentionState: 'active' | 'cleared';
  readonly continuousSeq: number;
}

/** 补传选项。 */
export interface ReplicaContinuityOptions {
  /** 会话持久化；正文从它读取。 */
  readonly persistence: SessionPersistence;
  /** 补传意图。 */
  readonly intents: ReplicaIntentStore;
  /** 控制平面地址。 */
  readonly controlUrl: string;
  /** 本设备标识。 */
  readonly deviceId: string;
  /** 节点令牌。 */
  readonly nodeToken: string;
  /** 遥测出口。 */
  readonly telemetry?: ChatdshTelemetry;
  /** 单批条数上限。 */
  readonly batchSize?: number;
  /** 单批字节上限。 */
  readonly batchBytes?: number;
  /** 单次请求超时毫秒数。 */
  readonly requestTimeoutMs?: number;
}

/** 上报结果。 */
type AppendReply =
  | { readonly kind: 'accepted'; readonly acknowledgedThrough: number; readonly appended: number; readonly duplicates: number; readonly retentionGeneration: number }
  | { readonly kind: 'gap'; readonly expectedSeq: number }
  | { readonly kind: 'conflict'; readonly seq: number }
  | { readonly kind: 'stale'; readonly currentGeneration: number; readonly state: string }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'unreachable' }
  | { readonly kind: 'invalid' };

/** 一次同步的累计结果。 */
interface SyncAccumulator {
  appended: number;
  duplicates: number;
  acknowledgedThrough: number;
  outcome: ReplicaSyncOutcome;
}

/** 设备侧连续补传。 */
export class ReplicaContinuity {
  private readonly persistence: SessionPersistence;
  private readonly intents: ReplicaIntentStore;
  private readonly controlUrl: string;
  private readonly deviceId: string;
  private readonly nodeToken: string;
  private readonly telemetry: ChatdshTelemetry | undefined;
  private readonly batchSize: number;
  private readonly batchBytes: number;
  private readonly requestTimeoutMs: number;
  /** 令牌被拒绝之后停止本进程的后续上报。 */
  private rejected = false;

  constructor(options: ReplicaContinuityOptions) {
    this.persistence = options.persistence;
    this.intents = options.intents;
    this.controlUrl = options.controlUrl.replace(/\/+$/, '');
    this.deviceId = options.deviceId;
    this.nodeToken = options.nodeToken;
    this.telemetry = options.telemetry;
    this.batchSize = options.batchSize ?? BATCH_LIMIT;
    this.batchBytes = options.batchBytes ?? BATCH_BYTES;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  /** 记录一个事件之后登记意图。事件已经写入权威日志。 */
  noteEvent(sessionId: string, seq: number): void {
    const state = this.intents.stateOf(sessionId);
    const generation = state?.retentionGeneration ?? 0;
    if (state === undefined) this.intents.setState(sessionId, generation, 'active');
    this.intents.markPending(sessionId, seq, generation);
  }

  /** 登记一个会话，等待下一轮同步。 */
  noteSession(sessionId: string): void {
    if (this.intents.stateOf(sessionId) !== undefined) return;
    this.intents.setState(sessionId, 0, 'active');
  }

  /** 仍有待补传事件的会话数。 */
  pendingSessions(): number {
    return this.intents.pendingSessions().length;
  }

  /** 令牌是否已被接收端拒绝。 */
  get unauthorized(): boolean {
    return this.rejected;
  }

  /**
   * 扫描全部已存储会话并逐一补齐。
   *
   * 枚举来源是会话持久化的会话清单与本地意图的并集，未打开的冷会话同样在内。
   * @returns 每个会话的同步结果。
   */
  async scanAll(): Promise<readonly ReplicaSessionSync[]> {
    const snapshots = await this.persistence.list();
    const ids = new Set<string>();
    for (const snapshot of snapshots) ids.add(String(snapshot.header.id));
    for (const id of this.intents.sessions()) ids.add(id);
    const results: ReplicaSessionSync[] = [];
    for (const id of [...ids].sort()) results.push(await this.syncSession(id));
    return results;
  }

  /** 只同步仍有意向的会话。 */
  async syncPending(): Promise<readonly ReplicaSessionSync[]> {
    const results: ReplicaSessionSync[] = [];
    for (const id of this.intents.pendingSessions()) results.push(await this.syncSession(id));
    return results;
  }

  /**
   * 反复扫描直到没有待补传内容、所有会话都要求人工处理或到达期限。
   * @param options - 期限，默认 30 秒。
   * @returns 最后一轮的结果。
   */
  async runUntilIdle(options: { readonly deadlineMs?: number } = {}): Promise<readonly ReplicaSessionSync[]> {
    const deadline = Date.now() + (options.deadlineMs ?? 30_000);
    let results: readonly ReplicaSessionSync[] = [];
    for (let attempt = 0; ; attempt += 1) {
      results = await this.scanAll();
      if (this.rejected || this.pendingSessions() === 0) return results;
      if (results.every((result) => result.outcome === 'stale' || result.outcome === 'conflict')) return results;
      if (Date.now() >= deadline) return results;
      const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)] ?? RETRY_DELAYS_MS[0];
      await new Promise((settle) => setTimeout(settle, delay + Math.floor(Math.random() * 250)));
    }
  }

  /**
   * 显式重新获取一个已清理的副本。
   *
   * 接收端给出新的保留代次，本地从空副本重新补齐。旧代次的意图在此之前一直被拒绝。
   * @param sessionId - 会话标识。
   * @returns 同步结果。
   */
  async reacquire(sessionId: string): Promise<ReplicaSessionSync> {
    const response = await fetch(`${this.controlUrl}${REPLICA_RETENTION_PATH}`, {
      method: 'POST',
      headers: { ...this.authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, action: 'reacquire' }),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (response.status === 401) {
      this.rejected = true;
      this.intents.setState(sessionId, this.intents.stateOf(sessionId)?.retentionGeneration ?? 0, 'unauthorized');
      return this.resultOf(sessionId, 'unauthorized', -1, 0, 0);
    }
    if (!response.ok) {
      throw new Error(`重新获取副本失败：HTTP ${response.status}`);
    }
    const payload = (await response.json()) as { generation?: unknown };
    if (typeof payload.generation !== 'number') throw new Error('重新获取副本的响应缺少保留代次');
    this.intents.setState(sessionId, payload.generation, 'active');
    this.intents.confirm(sessionId, -1, payload.generation);
    return this.syncSession(sessionId);
  }

  /** 同步一个会话。 */
  async syncSession(sessionId: string): Promise<ReplicaSessionSync> {
    if (this.rejected) return this.resultOf(sessionId, 'unauthorized', -1, 0, 0);
    const state = this.intents.stateOf(sessionId);
    if (state?.state === 'stale') return this.resultOf(sessionId, 'stale', this.acknowledgedOf(sessionId), 0, 0);
    if (state?.state === 'unauthorized') return this.resultOf(sessionId, 'unauthorized', this.acknowledgedOf(sessionId), 0, 0);

    let confirmed = this.intents.confirmedOf(sessionId);
    if (confirmed === undefined) {
      const remote = await this.fetchCursor(sessionId);
      if (remote === undefined) {
        if (this.rejected) {
          this.intents.setState(sessionId, state?.retentionGeneration ?? 0, 'unauthorized');
          return this.resultOf(sessionId, 'unauthorized', -1, 0, 0);
        }
        const generation = state?.retentionGeneration ?? 0;
        this.intents.setState(sessionId, generation, 'active');
        confirmed = { sessionId, retentionGeneration: generation, continuousSeq: -1 };
      } else {
        if (remote.retentionState === 'cleared') {
          this.intents.setState(sessionId, remote.retentionGeneration, 'stale');
          return this.resultOf(sessionId, 'stale', -1, 0, 0);
        }
        confirmed = {
          sessionId,
          retentionGeneration: remote.retentionGeneration,
          continuousSeq: remote.continuousSeq,
        };
        this.intents.confirm(sessionId, remote.continuousSeq, remote.retentionGeneration);
        this.intents.setState(sessionId, remote.retentionGeneration, 'active');
      }
    }

    let generation = confirmed.retentionGeneration;
    let cursorSeq = confirmed.continuousSeq;
    const accumulator: SyncAccumulator = {
      appended: 0,
      duplicates: 0,
      acknowledgedThrough: cursorSeq,
      outcome: 'idle',
    };

    let handle: Awaited<ReturnType<SessionPersistence['open']>> | undefined;
    try {
      handle = await this.persistence.open(sessionId as SessionId, 'read');
    } catch (error) {
      if (error instanceof SessionPersistenceNotFoundError) {
        return this.resultOf(sessionId, 'idle', cursorSeq, 0, 0);
      }
      throw error;
    }
    let retreats = 0;
    try {
      for (;;) {
        const slice = await handle.read(cursorSeq + 1, this.batchSize);
        if (slice.events.length === 0) break;
        const batch = this.limitBytes(slice.events);
        this.intents.markPendingBatch(sessionId, batch.map((event) => Number(event.seq)), generation);
        const reply = await this.sendBatch(sessionId, generation, batch);
        if (reply.kind === 'accepted') {
          accumulator.appended += reply.appended;
          accumulator.duplicates += reply.duplicates;
          accumulator.acknowledgedThrough = reply.acknowledgedThrough;
          accumulator.outcome = reply.appended > 0 ? 'pushed' : 'duplicate';
          generation = reply.retentionGeneration;
          cursorSeq = reply.acknowledgedThrough;
          this.intents.confirm(sessionId, cursorSeq, generation);
          this.intents.setState(sessionId, generation, 'active');
          continue;
        }
        if (reply.kind === 'gap') {
          accumulator.outcome = 'gap';
          this.intents.setState(sessionId, generation, 'gap');
          if (reply.expectedSeq - 1 < cursorSeq && retreats < 3) {
            retreats += 1;
            cursorSeq = reply.expectedSeq - 1;
            this.intents.confirm(sessionId, cursorSeq, generation);
            continue;
          }
          break;
        }
        if (reply.kind === 'conflict') {
          accumulator.outcome = 'conflict';
          this.intents.setState(sessionId, generation, 'conflict');
          break;
        }
        if (reply.kind === 'stale') {
          accumulator.outcome = 'stale';
          this.intents.setState(sessionId, reply.currentGeneration, 'stale');
          break;
        }
        if (reply.kind === 'unauthorized') {
          accumulator.outcome = 'unauthorized';
          this.rejected = true;
          this.intents.setState(sessionId, generation, 'unauthorized');
          break;
        }
        accumulator.outcome = 'unreachable';
        break;
      }
    } finally {
      await handle?.close();
    }
    const remaining = this.pendingCountOf(sessionId);
    if (accumulator.outcome === 'pushed' || accumulator.outcome === 'duplicate') {
      this.recordWatermark(sessionId, remaining);
    }
    return this.resultOf(sessionId, accumulator.outcome, accumulator.acknowledgedThrough, accumulator.appended, accumulator.duplicates);
  }

  /** 把一条已提交事件上报一批。 */
  private async sendBatch(sessionId: string, generation: number, events: readonly SessionEvent[]): Promise<AppendReply> {
    const body = JSON.stringify({
      sessionId,
      retentionGeneration: generation,
      events: events.map((event) => ({
        seq: Number(event.seq),
        kind: event.type,
        time: event.time,
        payload: event.data,
      })),
    });
    const lastSeq = events.length === 0 ? -1 : Number(events[events.length - 1]?.seq ?? -1);
    const run = async (span: TelemetrySpan | undefined): Promise<AppendReply> => {
      const headers = this.authHeaders();
      headers['content-type'] = 'application/json';
      if (this.telemetry !== undefined) {
        const carrier = this.telemetry.inject({});
        if (carrier.traceparent !== undefined) headers.traceparent = carrier.traceparent;
        if (carrier.tracestate !== undefined) headers.tracestate = carrier.tracestate;
      }
      let response: Response;
      try {
        response = await fetch(`${this.controlUrl}${REPLICA_PUSH_PATH}`, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });
      } catch (error) {
        span?.recordException(error);
        span?.setAttribute('outcome', 'unreachable');
        return { kind: 'unreachable' };
      }
      let payload: Record<string, unknown> = {};
      try {
        payload = (await response.json()) as Record<string, unknown>;
      } catch {
        payload = {};
      }
      if (response.status === 200) {
        const acknowledgedThrough = Number(payload.acknowledgedThrough ?? lastSeq);
        const appended = Number(payload.appended ?? 0);
        const duplicates = Number(payload.duplicates ?? 0);
        const retentionGeneration = Number(payload.retentionGeneration ?? generation);
        span?.setAttribute('outcome', appended > 0 ? 'pushed' : 'duplicate');
        return { kind: 'accepted', acknowledgedThrough, appended, duplicates, retentionGeneration };
      }
      if (response.status === 401) {
        span?.setAttribute('outcome', 'unauthorized');
        return { kind: 'unauthorized' };
      }
      const error = typeof payload.error === 'string' ? payload.error : '';
      if (error === 'replica-gap') {
        span?.setAttribute('outcome', 'gap');
        return { kind: 'gap', expectedSeq: Number(payload.expectedSeq ?? lastSeq + 1) };
      }
      if (error === 'replica-content-conflict') {
        span?.setAttribute('outcome', 'conflict');
        return { kind: 'conflict', seq: Number(payload.seq ?? lastSeq) };
      }
      if (error === 'replica-retention-stale') {
        span?.setAttribute('outcome', 'stale');
        return {
          kind: 'stale',
          currentGeneration: Number(payload.currentGeneration ?? generation),
          state: typeof payload.state === 'string' ? payload.state : 'active',
        };
      }
      span?.setAttribute('outcome', 'invalid');
      return { kind: 'invalid' };
    };

    if (this.telemetry === undefined) return run(undefined);
    return this.telemetry.runSpan('chatdsh.sync.event.push', {
      'session.id': sessionId,
      seq: lastSeq,
    }, run);
  }

  /** 读控制平面上的会话游标。 */
  private async fetchCursor(sessionId: string): Promise<RemoteReplicaCursor | undefined> {
    let response: Response;
    try {
      response = await fetch(`${this.controlUrl}${REPLICA_PUSH_PATH}?sessionId=${encodeURIComponent(sessionId)}`, {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch {
      return undefined;
    }
    if (response.status === 401) {
      this.rejected = true;
      return undefined;
    }
    if (!response.ok) return undefined;
    const payload = (await response.json()) as Record<string, unknown>;
    if (typeof payload.continuousSeq !== 'number' || typeof payload.retentionGeneration !== 'number') {
      return undefined;
    }
    return {
      retentionGeneration: payload.retentionGeneration,
      retentionState: payload.retentionState === 'cleared' ? 'cleared' : 'active',
      continuousSeq: payload.continuousSeq,
    };
  }

  /** 记一次水位事件；事件正文与路径都不进遥测。 */
  private recordWatermark(sessionId: string, remaining: number): void {
    if (this.telemetry === undefined) return;
    this.telemetry.event('chatdsh.sync.watermark', {
      'session.id': sessionId,
      'lag.events': remaining,
    });
    this.telemetry.gauge('chatdsh_replica_lag_sessions', { description: '副本落后会话数' })
      .record(this.pendingSessions());
  }

  /** 请求头里的认证信息。 */
  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = { [NODE_HEADERS.id]: this.deviceId };
    if (this.nodeToken !== '') headers.authorization = `Bearer ${this.nodeToken}`;
    return headers;
  }

  /** 按字节上限截断一批；首条无论如何保留。 */
  private limitBytes(events: readonly SessionEvent[]): readonly SessionEvent[] {
    const batch: SessionEvent[] = [];
    let bytes = 0;
    for (const event of events) {
      const size = Buffer.byteLength(JSON.stringify(event.data));
      if (batch.length > 0 && bytes + size > this.batchBytes) break;
      batch.push(event);
      bytes += size;
    }
    return batch;
  }

  /** 本会话未确认的意图条数。 */
  private pendingCountOf(sessionId: string): number {
    return this.intents.pendingCountOf(sessionId);
  }

  /** 已确认的前缀。 */
  private acknowledgedOf(sessionId: string): number {
    return this.intents.confirmedOf(sessionId)?.continuousSeq ?? -1;
  }

  /** 组装结果。 */
  private resultOf(
    sessionId: string,
    outcome: ReplicaSyncOutcome,
    acknowledgedThrough: number,
    appended: number,
    duplicates: number,
  ): ReplicaSessionSync {
    return {
      sessionId,
      outcome,
      acknowledgedThrough,
      appended,
      duplicates,
      remaining: this.pendingCountOf(sessionId),
    };
  }
}
