/**
 * 设备区段：执行节点与访问客户端分组、当前设备标记、详情、链路检查与撤销。
 *
 * 数据来自控制平面的设备管理接口：列表、配对码签发、撤销与链路检查。分组标题与每行都
 * 有可访问名称，详情与撤销都在对话框里完成，对话框约束焦点并在关闭时把焦点交回触发
 * 元素。列表读取失败显示明确原因与重新读取入口，全部设备离线时列表照常显示。
 * @module @chatdsh/client-account
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button, EmptyState, ErrorNote, List, Panel, Row, Skeleton, StatusLine } from '@chatdsh/core-ui-kit';
import { DeviceDetailDialog, type DetailTarget } from './detail.tsx';
import { describeFailure, formatRelative, platformLabel, ROLE_LABELS } from './describe.ts';
import { createDeviceGateway, type DeviceCredentialSource } from './gateway.ts';
import { PairingPanel } from './pairing.tsx';
import { RevokeDialog, type RevokeTarget } from './revoke.tsx';
import type { AccessClient, Device, DeviceGateway, DeviceList, Loadable } from './types.ts';

/** 席位名。 */
export const SECTION_SLOT = 'settings.section';

/** 区段标识。 */
export const SECTION_ID = 'chatdsh-devices';

/** 浏览器侧依赖：只等席位服务，模块加载顺序由模块图自己保证。 */
export const inject = ['slots'];

/** 区段属性。 */
export interface DeviceSectionProps {
  /** 数据入口；测试与嵌入场景可以直接传入。 */
  readonly gateway?: DeviceGateway;
  /** 宿主提供的设备凭据；缺省时请求不带凭据，控制平面会以 `device-token-required` 拒绝。 */
  readonly credential?: DeviceCredentialSource;
}

let sharedGateway: DeviceGateway | undefined;

/**
 * 取数据入口。
 * @param provided - 调用方传入的入口。
 * @param credential - 宿主提供的设备凭据。
 * @returns 数据入口。
 */
function gatewayOf(provided?: DeviceGateway, credential?: DeviceCredentialSource): DeviceGateway {
  if (provided !== undefined) return provided;
  if (credential !== undefined) return createDeviceGateway({ credential });
  sharedGateway ??= createDeviceGateway();
  return sharedGateway;
}

/**
 * 一台执行节点的行。
 * @param props - 记录、当前时刻与两个回调。
 * @returns 列表行。
 */
function NodeRow({ record, now, onDetail, onRevoke }: {
  readonly record: Device;
  readonly now: number;
  readonly onDetail: (target: DetailTarget) => void;
  readonly onRevoke: (target: RevokeTarget) => void;
}) {
  const revoked = record.revokedAt !== undefined;
  return (
    <Row
      dot={revoked ? 'idle' : record.online ? 'ok' : 'warn'}
      title={<span data-device-name={record.name}>{record.name}</span>}
      badge={(
        <>
          {record.currentExecutor ? <Badge tone="brand">当前执行设备</Badge> : null}
          {revoked ? <Badge tone="danger">已撤销</Badge> : <Badge tone={record.online ? 'ok' : 'neutral'}>{record.online ? '在线' : '离线'}</Badge>}
        </>
      )}
      meta={`${platformLabel(record.platform)} · ${ROLE_LABELS[record.role]} · 最近活动 ${formatRelative(record.lastSeenAt, now)}`}
      actions={(
        <>
          <Button id={`chdsh-device-open-${record.id}`} aria-label={`查看设备详情：${record.name}`} onClick={() => onDetail({ kind: 'node', record })}>
            详情
          </Button>
          {revoked ? null : (
            <Button
              id={`chdsh-device-revoke-${record.id}`}
              tone="danger"
              aria-label={`撤销设备：${record.name}`}
              onClick={() => onRevoke({ id: record.id, name: record.name, platform: record.platform, kindLabel: ROLE_LABELS[record.role] })}
            >
              撤销
            </Button>
          )}
        </>
      )}
    />
  );
}

/**
 * 一台访问客户端的行。
 * @param props - 记录、当前时刻与两个回调。
 * @returns 列表行。
 */
function AccessRow({ record, now, onDetail, onRevoke }: {
  readonly record: AccessClient;
  readonly now: number;
  readonly onDetail: (target: DetailTarget) => void;
  readonly onRevoke: (target: RevokeTarget) => void;
}) {
  const revoked = record.revokedAt !== undefined;
  return (
    <Row
      dot={revoked ? 'idle' : 'ok'}
      title={<span data-device-name={record.name}>{record.name}</span>}
      badge={(
        <>
          {record.current ? <Badge tone="brand">当前客户端</Badge> : null}
          {revoked ? <Badge tone="danger">已撤销</Badge> : <Badge tone="neutral">访问客户端</Badge>}
        </>
      )}
      meta={`${platformLabel(record.platform)} · 最近活动 ${formatRelative(record.lastSeenAt, now)}`}
      actions={(
        <>
          <Button id={`chdsh-device-open-${record.id}`} aria-label={`查看客户端详情：${record.name}`} onClick={() => onDetail({ kind: 'access', record })}>
            详情
          </Button>
          {revoked ? null : (
            <Button
              id={`chdsh-device-revoke-${record.id}`}
              tone="danger"
              aria-label={`撤销客户端：${record.name}`}
              onClick={() => onRevoke({ id: record.id, name: record.name, platform: record.platform, kindLabel: '访问客户端' })}
            >
              撤销
            </Button>
          )}
        </>
      )}
    />
  );
}

/**
 * 设置页区段：设备的完整界面。
 * @param props - 可选的数据入口与设备凭据。
 * @returns 区段内容。
 */
export function DeviceSection({ gateway, credential }: DeviceSectionProps = {}) {
  const [face] = useState(() => gatewayOf(gateway, credential));
  const [list, setList] = useState<Loadable<DeviceList>>({ status: 'loading' });
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [detail, setDetail] = useState<DetailTarget | undefined>(undefined);
  const [revoking, setRevoking] = useState<RevokeTarget | undefined>(undefined);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const reload = useCallback((): void => {
    face.list().then(
      (value) => {
        if (!alive.current) return;
        setList({ status: 'ready', value });
        face.noteAction('device-list', 'ok');
      },
      (error: unknown) => {
        if (!alive.current) return;
        setList({ status: 'failed', error });
        face.noteAction('device-list', 'failed');
      },
    );
  }, [face]);

  useEffect(() => {
    reload();
  }, [reload]);

  if (list.status === 'failed') {
    return (
      <Panel title="设备">
        <ErrorNote>{`设备列表读取失败：${describeFailure(list.error)}`}</ErrorNote>
        <Button id="chdsh-device-reload" onClick={reload}>重新读取</Button>
      </Panel>
    );
  }
  if (list.status === 'loading') {
    return <Panel title="设备"><Skeleton rows={3} /></Panel>;
  }

  const { nodes, accessClients } = list.value;
  const now = Date.now();
  const empty = nodes.length === 0 && accessClients.length === 0;

  return (
    <Panel
      title="设备"
      subtitle="执行节点与访问客户端分别登记。当前设备用标记标出，离线的设备仍然可以阅读。"
      count={`${String(nodes.length + accessClients.length)} 台`}
    >
      {notice === undefined ? null : <StatusLine>{notice}</StatusLine>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 'var(--cdh-s2)' }}>
        <Button id="chdsh-device-refresh" onClick={reload}>刷新列表</Button>
      </div>
      {empty ? (
        <EmptyState>还没有登记的设备。生成配对码，把第一台执行节点加入控制平面。</EmptyState>
      ) : (
        <>
          <section aria-labelledby="chdsh-device-nodes-title" data-device-group="nodes">
            <h4 id="chdsh-device-nodes-title">{`执行节点（${String(nodes.length)}）`}</h4>
            {nodes.length === 0 ? (
              <StatusLine>还没有登记的执行节点。</StatusLine>
            ) : (
              <List>
                {nodes.map((record) => (
                  <NodeRow key={record.id} record={record} now={now} onDetail={setDetail} onRevoke={setRevoking} />
                ))}
              </List>
            )}
          </section>
          <section aria-labelledby="chdsh-device-clients-title" data-device-group="access-clients">
            <h4 id="chdsh-device-clients-title">{`访问客户端（${String(accessClients.length)}）`}</h4>
            {accessClients.length === 0 ? (
              <StatusLine>还没有登记的访问客户端。</StatusLine>
            ) : (
              <List>
                {accessClients.map((record) => (
                  <AccessRow key={record.id} record={record} now={now} onDetail={setDetail} onRevoke={setRevoking} />
                ))}
              </List>
            )}
          </section>
        </>
      )}
      <PairingPanel gateway={face} onIssued={() => setNotice('已签发新的配对码，请在有效期内完成配对。')} />
      {detail === undefined ? null : (
        <DeviceDetailDialog
          gateway={face}
          target={detail}
          onClose={() => setDetail(undefined)}
          onRevoke={(target) => {
            setDetail(undefined);
            setRevoking(target);
          }}
        />
      )}
      {revoking === undefined ? null : (
        <RevokeDialog
          gateway={face}
          target={revoking}
          onClose={() => setRevoking(undefined)}
          onDone={(message) => {
            setRevoking(undefined);
            setNotice(message);
            reload();
          }}
        />
      )}
    </Panel>
  );
}

/** 席位服务的最小形状。 */
interface ClientSlots {
  inject(key: string, callback: () => () => void): () => void;
  register(spec: { name: string; id?: string; order?: number; label?: () => string; locale?: string }, Component: () => unknown): () => void;
}

/** 客户端根上下文的形状；宿主装配访问认证之后通过 `deviceCredential` 提供设备凭据。 */
interface ClientFace {
  readonly slots: ClientSlots;
  readonly deviceCredential?: DeviceCredentialSource;
}

/**
 * 注册设置页区段。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientFace): void {
  const credential = ctx.deviceCredential;
  ctx.slots.inject(SECTION_SLOT, () => ctx.slots.register({
    name: SECTION_SLOT,
    id: SECTION_ID,
    order: 55,
    label: () => '设备',
    locale: 'chatdsh.devices',
  }, () => <DeviceSection credential={credential} />));
}
