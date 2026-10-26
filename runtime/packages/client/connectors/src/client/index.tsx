import { buildRemoteContribution, unwrapRemoteResult } from '@chatdsh/core-remote-client';
import { z } from 'zod';
/**
 * 连接器面板：列出已登记的外部连接器。
 *
 * 数据经 Remote 调用取得（服务名 `chatdshConnectors`）。面板只读展示：名字、传输方式、
 * 目标与凭据所在的环境变量名。凭据本身不在记录里，因此这里只显示变量名。
 * @module @chatdsh/client-connectors
 */

import { useEffect, useState } from 'react';
import { Badge, Button, EmptyState, ErrorNote, List, Panel, Row, Skeleton, StatusLine } from '@chatdsh/core-ui-kit';

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
      setEnabled?: (id: string, enabled: boolean) => Promise<ConnectorRecord>;
      syncMcpRows?: () => Promise<unknown>;
    };
  };
}

/** 席位名。 */
export const SECTION_SLOT = 'settings.section';

/** 区段标识。 */
export const SECTION_ID = 'chatdsh-connectors';

/** 浏览器侧依赖：只等席位服务，模块加载顺序由模块图自己保证。 */
export const inject = ['slots', 'remote'];

let clientFace: ClientFace | undefined;

/** 描述一个连接器的目标。 */
function targetOf(record: ConnectorRecord): string {
  if (record.transport === 'http') return record.url ?? '地址未填写';
  const args = record.args === undefined || record.args.length === 0 ? '' : ` ${record.args.join(' ')}`;
  return `${record.command ?? '命令未填写'}${args}`;
}

/** 记录一次界面动作，失败不打断界面。 */
function noteAction(outcome: 'ok' | 'failed'): void {
  // 浏览器侧不持有 OpenObserve 凭据，直接编成 OTLP 日志载荷交给同源中继；
  // 中继只转发不解析，形状必须与 client-telemetry 生成的一致。
  void fetch('/chatdsh/telemetry/browser', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-chatdsh-signal': 'logs', 'x-chatdsh-csrf': '1' },
    body: JSON.stringify({
    resourceLogs: [{
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: 'chatdsh-browser' } },
          { key: 'chatdsh.surface', value: { stringValue: 'browser' } },
        ],
      },
      scopeLogs: [{
        scope: { name: '@chatdsh/client-connectors' },
        logRecords: [{
          timeUnixNano: String(Date.now() * 1_000_000),
          severityNumber: 9,
          severityText: 'INFO',
          body: { stringValue: 'chatdsh.client.ui.action' },
          attributes: [
            { key: 'action', value: { stringValue: 'connector-toggle' } },
            { key: 'outcome', value: { stringValue: outcome } },
          ],
        }],
      }],
    }],
  }),
    keepalive: true,
  }).catch(() => undefined);
}

/** 设置页区段。 */
export function ConnectorsSection({ remote }: { remote?: NonNullable<ClientFace['remote']> } = {}) {
  // 测试与嵌入场景可以直接传 remote；正常装配走 apply 写入的模块级上下文。
  const face = remote ?? clientFace?.remote;
  const [connectors, setConnectors] = useState<ConnectorRecord[] | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const load = face?.chatdshConnectors?.list;
    if (load === undefined) {
      setFailed(true);
      return;
    }
    load.call(face?.chatdshConnectors).then(
      (result) => {
        if (!cancelled) setConnectors(unwrapRemoteResult(result));
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [remote]);

  /**
   * 切换一个连接器的启用状态。
   *
   * 停用后必须再调一次 `syncMcpRows`：加载器行由这条同步按记录重建，只改记录不会让
   * 已挂载的 MCP 行消失。
   */
  function toggle(record: ConnectorRecord): void {
    const connectorsRemote = face?.chatdshConnectors;
    if (connectorsRemote?.setEnabled === undefined || connectorsRemote.syncMcpRows === undefined) {
      setError('连接器接口不可用');
      return;
    }
    connectorsRemote.setEnabled.call(connectorsRemote, record.id, !record.enabled).then(
      (updatedResult) => {
        const updated = unwrapRemoteResult<ConnectorRecord>(updatedResult);
        setConnectors((current) => (current ?? []).map((item) => (item.id === updated.id ? updated : item)));
        setError(undefined);
        return connectorsRemote.syncMcpRows?.call(connectorsRemote).then(() => noteAction('ok'), () => {
          setError('记录已更新，但加载器行同步失败');
          noteAction('failed');
        });
      },
      () => {
        setError('切换连接器状态失败');
        noteAction('failed');
      },
    );
  }

  if (failed) return <Panel title="连接器"><StatusLine tone="danger">连接器列表暂不可用。</StatusLine></Panel>;
  if (connectors === undefined) return <Panel title="连接器"><Skeleton rows={3} /></Panel>;
  if (connectors.length === 0) return <Panel title="连接器"><EmptyState>还没有登记外部连接器。</EmptyState></Panel>;

  return (
    <Panel title="连接器" count={`${connectors.length}`}>
      {error === undefined ? null : <ErrorNote>{error}</ErrorNote>}
      <List>
        {connectors.map((record) => (
          <Row
            key={record.id}
            dot={record.enabled ? 'ok' : 'idle'}
            title={record.name}
            badge={<Badge tone={record.enabled ? 'ok' : 'neutral'}>{record.enabled ? '启用' : '已停用'}</Badge>}
            meta={`${record.transport} · ${targetOf(record)}${record.credentialEnv === undefined ? '' : ` · 凭据来自 ${record.credentialEnv}`}`}
            actions={<Button onClick={() => toggle(record)}>{record.enabled ? '停用' : '启用'}</Button>}
          />
        ))}
      </List>
    </Panel>
  );
}

/**
 * 注册设置页区段。
 * @param ctx - 客户端根上下文。
 */
export async function apply(ctx: ClientFace & { slots: ClientSlots }): Promise<void> {
  clientFace = ctx;
  const remoteHost = ctx as unknown as {
    remote: { $mount(contribution: unknown): Promise<unknown> };
    inject(keys: string[], callback: (scope: ClientFace) => void): unknown;
  };
  await remoteHost.remote.$mount(buildRemoteContribution('chatdshConnectors', {
    'chatdshConnectors/list': { parameters: [] },
    'chatdshConnectors/mcpRows': { parameters: [] },
    'chatdshConnectors/syncMcpRows': { parameters: [] },
    'chatdshConnectors/save': { parameters: [{ name: 'input', kind: 'json' }] },
    'chatdshConnectors/delete': { parameters: [{ name: 'id', kind: 'string' }] },
    'chatdshConnectors/setEnabled': { parameters: [{ name: 'id', kind: 'string' }, { name: 'enabled', kind: 'boolean' }] },
    'chatdshConnectors/mcpStatus': { parameters: [] },
    'chatdshConnectors/mcpTools': { parameters: [] },
    'chatdshConnectors/refreshMcpRegistry': { parameters: [] },
    'chatdshConnectors/callMcpTool': { parameters: [{ name: 'name', kind: 'string' }, { name: 'args', kind: 'json' }] },
  }, z));
  await new Promise<void>((resolve) => {
    remoteHost.inject(['remote.chatdshConnectors'], (scope) => {
      clientFace = scope;
      resolve();
    });
  });

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
