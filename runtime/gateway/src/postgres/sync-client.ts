/**
 * 同步 Postgres 客户端：主线程阻塞等待，worker 里跑真实的 `pg` 连接。
 *
 * 控制平面的存储接口是同步签名（默认实现基于 `node:sqlite`），而 `pg` 只有异步 API。
 * 这一层把一次查询请求投给 worker，主线程在共享内存上等待，worker 执行完唤醒主线程并回送
 * 结果。调用串行化，事务边界也就是同一条连接上的 `begin`/`commit`。
 *
 * 数据库不可达、连接终止都直接抛错，没有任何退回到本地存储的分支。
 * @module @chatdsh/gateway/postgres/sync-client
 */

import { MessageChannel, Worker, receiveMessageOnPort, type MessagePort } from 'node:worker_threads';
import {
  PostgresConfigError,
  PostgresUnavailableError,
  errorCodeOf,
  isConnectionFailure,
  type PgRow,
} from './pg-module.ts';

/** 一次查询结果。 */
export interface SyncQueryResult {
  /** 结果行。 */
  readonly rows: PgRow[];
  /** 受影响行数。 */
  readonly rowCount: number | null;
}

/** 一条应答。 */
interface SyncReply {
  readonly id: number;
  readonly ok: boolean;
  readonly rows?: PgRow[];
  readonly rowCount?: number | null;
  readonly error?: { readonly name: string; readonly message: string; readonly code?: string };
}

/** 单次等待的上限：超过即判定数据库无响应。 */
const WAIT_TIMEOUT_MS = 30_000;

/** 同步 Postgres 客户端。 */
export class SyncPostgres {
  private readonly worker: Worker;
  private readonly port: MessagePort;
  private readonly signal: Int32Array;
  private nextId = 1;
  private closed = false;

  constructor(connectionString: string) {
    const trimmed = connectionString.trim();
    if (trimmed === '') throw new PostgresConfigError('Postgres 控制平面缺少连接串，拒绝构造连接');
    const shared = new SharedArrayBuffer(4);
    this.signal = new Int32Array(shared);
    const channel = new MessageChannel();
    this.port = channel.port1;
    const workerPort = channel.port2;
    this.worker = new Worker(new URL('./sync-worker.js', import.meta.url), {
      workerData: { connectionString: trimmed, port: workerPort, signal: shared },
      transferList: [workerPort],
    });
    this.worker.unref();
    this.port.unref();
    const startup = this.awaitReply('建立连接');
    if (!startup.ok) {
      void this.worker.terminate();
      this.port.close();
      throw this.toError(startup.error);
    }
  }

  /**
   * 执行一次查询。
   *
   * @param text - SQL 文本，参数用 `$1`、`$2` 占位。
   * @param values - 参数值。
   * @returns 结果行与受影响行数。
   */
  query(text: string, values: readonly unknown[] = []): SyncQueryResult {
    if (this.closed) throw new Error('同步 Postgres 客户端已经关闭');
    const id = this.nextId++;
    this.port.postMessage({ id, kind: 'query', text, values });
    const reply = this.awaitReply('执行查询');
    if (reply.id !== id) throw new Error(`同步 Postgres 应答编号错位：期望 ${id}，实际 ${reply.id}`);
    if (!reply.ok) throw this.toError(reply.error);
    return { rows: reply.rows ?? [], rowCount: reply.rowCount ?? null };
  }

  /** 关闭连接与 worker；可重复调用。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    let failure: Error | undefined;
    try {
      const id = this.nextId++;
      this.port.postMessage({ id, kind: 'end' });
      const reply = this.awaitReply('关闭连接');
      if (!reply.ok) failure = this.toError(reply.error);
    } finally {
      void this.worker.terminate();
      this.port.close();
    }
    // 连接已经被数据库断开时，回收随 worker 终止一并完成，不再把关闭失败当成新错误。
    if (failure !== undefined && !isConnectionFailure(failure)) throw failure;
  }

  /** 阻塞等待一条应答。 */
  private awaitReply(operation: string): SyncReply {
    const waited = Atomics.wait(this.signal, 0, 0, WAIT_TIMEOUT_MS);
    if (waited === 'timed-out') {
      throw new PostgresUnavailableError(`Postgres 在${operation}时超过 ${WAIT_TIMEOUT_MS} 毫秒没有响应`);
    }
    const received = receiveMessageOnPort(this.port);
    if (received === undefined) throw new PostgresUnavailableError(`Postgres 在${operation}时没有回送结果`);
    Atomics.store(this.signal, 0, 0);
    return received.message as SyncReply;
  }

  /** 把 worker 回送的错误还原成异常。 */
  private toError(error: SyncReply['error']): Error {
    if (error === undefined) return new PostgresUnavailableError('Postgres 没有给出失败原因');
    const reconstructed = new Error(error.message);
    reconstructed.name = error.name;
    if (error.code !== undefined) (reconstructed as { code?: string }).code = error.code;
    if (errorCodeOf(reconstructed) === undefined && /terminated|closed|not queryable|refused|unreachable/i.test(error.message)) {
      return new PostgresUnavailableError(error.message, { cause: reconstructed });
    }
    return reconstructed;
  }
}
