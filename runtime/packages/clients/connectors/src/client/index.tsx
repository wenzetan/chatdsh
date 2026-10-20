/**
 * 连接器面板：列出已登记的外部连接器。
 *
 * 数据经 Remote 调用取得（服务名 `chatdshConnectors`）。面板只读展示：名字、传输方式、
 * 目标与凭据所在的环境变量名。凭据本身不在记录里，因此这里只显示变量名。
 * @module @chatdsh/client-connectors
 */

import { useEffect, useState } from 'react';

/** 一条连接器记录。 */
interface ConnectorRecord {
  readonly id: string;
  readonly name: string;
  readonly transport: 'stdio' | 'http';
  readonly command?: string;
  readonly args?: readonly string[];
  readonly url?: string;
  readonly credentialEnv?: string;
  readonly enabled: boolean;
}

/** 浏览器侧上下文的可用面。 */
interface ClientFace {
  readonly remote?: {
    readonly chatdshConnectors?: {
      list?: () => Promise<ConnectorRecord[]>;
    };
  };
}

/** 席位名。 */
export const SECTION_SLOT = 'settings.section';

/** 区段标识。 */
export const SECTION_ID = 'chatdsh-connectors';

/** 浏览器侧依赖：只等席位服务，模块加载顺序由模块图自己保证。 */
export const inject = ['slots'];

let clientFace: ClientFace | undefined;

/** 描述一个连接器的目标。 */
function targetOf(record: ConnectorRecord): string {
  if (record.transport === 'http') return record.url ?? '地址未填写';
  const args = record.args === undefined || record.args.length === 0 ? '' : ` ${record.args.join(' ')}`;
  return `${record.command ?? '命令未填写'}${args}`;
}

/** 设置页区段。 */
function ConnectorsSection() {
  const [connectors, setConnectors] = useState<ConnectorRecord[] | undefined>(undefined);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = clientFace?.remote?.chatdshConnectors?.list;
    if (load === undefined) {
      setFailed(true);
      return;
    }
    load.call(clientFace?.remote?.chatdshConnectors).then(
      (records) => {
        if (!cancelled) setConnectors(records);
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (failed) return <p style={{ fontSize: 13, opacity: 0.7 }}>连接器列表暂不可用。</p>;
  if (connectors === undefined) return <p style={{ fontSize: 13, opacity: 0.7 }}>正在读取连接器…</p>;
  if (connectors.length === 0) return <p style={{ fontSize: 13, opacity: 0.7 }}>还没有登记外部连接器。</p>;

  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: 13 }}>
      {connectors.map((record) => (
        <li key={record.id} style={{ padding: '8px 0', borderBottom: '1px solid rgba(0,0,0,0.08)' }}>
          <div style={{ fontWeight: 600 }}>
            {record.name}
            {record.enabled ? '' : '（已停用）'}
          </div>
          <div style={{ opacity: 0.7 }}>
            {record.transport} · {targetOf(record)}
          </div>
          {record.credentialEnv === undefined ? null : (
            <div style={{ opacity: 0.6 }}>凭据来自环境变量 {record.credentialEnv}</div>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * 注册设置页区段。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientFace & { slots: ClientSlots }): void {
  clientFace = ctx;
  ctx.slots.inject(SECTION_SLOT, () => ctx.slots.register({
    name: SECTION_SLOT,
    id: SECTION_ID,
    order: 70,
    label: () => '连接器',
    locale: 'chatdsh.connectors',
  }, ConnectorsSection));
}

/** 席位服务的最小形状。 */
interface ClientSlots {
  inject(key: string, callback: () => () => void): () => void;
  register(spec: { name: string; id?: string; order?: number; label?: () => string; locale?: string }, Component: () => unknown): () => void;
}
