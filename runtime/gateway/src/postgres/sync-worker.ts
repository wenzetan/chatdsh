/**
 * 同步桥的 worker 侧。
 *
 * worker 持有真实的 `pg` 连接，经同一条消息通道接收查询请求并回送结果；每次执行完把共享
 * 内存里的标志置位并唤醒被阻塞的主线程。查询串、参数与结果都不写日志。
 * @module @chatdsh/gateway/postgres/sync-worker
 */

import { workerData, type MessagePort } from 'node:worker_threads';
import { asUnavailable, errorCodeOf, loadPg, type PgConnection, type PgRow } from './pg-module.ts';

/** 主线程传给 worker 的启动参数。 */
export interface SyncWorkerData {
  /** PostgreSQL 连接串。 */
  readonly connectionString: string;
  /** 与主线程共享的消息通道。 */
  readonly port: MessagePort;
  /** 唤醒标志。 */
  readonly signal: SharedArrayBuffer;
}

/** 一条请求。 */
interface SyncRequest {
  /** 请求编号。 */
  readonly id: number;
  /** 请求种类。 */
  readonly kind: 'query' | 'end';
  /** SQL 文本。 */
  readonly text?: string;
  /** 参数。 */
  readonly values?: readonly unknown[];
}

/** 一条应答。 */
interface SyncReply {
  /** 请求编号。 */
  readonly id: number;
  /** 是否成功。 */
  readonly ok: boolean;
  /** 结果行。 */
  readonly rows?: PgRow[];
  /** 受影响行数。 */
  readonly rowCount?: number | null;
  /** 失败的说明；只带错误类型、错误码与消息，不带连接串。 */
  readonly error?: { readonly name: string; readonly message: string; readonly code?: string };
}

const data = workerData as SyncWorkerData;
const signal = new Int32Array(data.signal);
const port = data.port;

/** 回送一条应答并唤醒主线程。 */
function reply(message: SyncReply): void {
  port.postMessage(message);
  Atomics.store(signal, 0, message.id);
  Atomics.notify(signal, 0, 1);
}

/** 把错误压成可回送的结构。 */
function failure(id: number, error: unknown): SyncReply {
  const wrapped = asUnavailable(error, '执行查询');
  const code = errorCodeOf(wrapped);
  return {
    id,
    ok: false,
    error: { name: wrapped.name, message: wrapped.message, ...(code === undefined ? {} : { code }) },
  };
}

let client: PgConnection | undefined;

/** 建立连接；失败时把原因回送主线程。 */
async function connect(): Promise<void> {
  const module = loadPg();
  // `int8` 默认被解析成字符串；控制平面的时刻与计数都在安全整数范围内，统一解析成数字。
  module.types.setTypeParser(20, (value: string) => Number(value));
  const { Client } = module;
  client = new Client({
    connectionString: data.connectionString,
    application_name: 'chatdsh-gateway-postgres',
  });
  await client.connect();
  await client.query('select 1');
}

await connect().then(
  () => reply({ id: 0, ok: true }),
  (error: unknown) => reply(failure(0, error)),
);

port.on('message', (request: SyncRequest) => {
  void (async () => {
    try {
      if (request.kind === 'end') {
        await client?.end();
        client = undefined;
        reply({ id: request.id, ok: true });
        port.close();
        return;
      }
      const connection = client;
      if (connection === undefined) throw new Error('同步桥的连接已经关闭');
      const result = await connection.query(request.text ?? '', request.values ?? []);
      reply({ id: request.id, ok: true, rows: result.rows, rowCount: result.rowCount });
    } catch (error) {
      reply(failure(request.id, error));
    }
  })();
});
