/**
 * 设备详情：配对时刻、角色、当前设备标记、链路检查与撤销入口。
 *
 * 链路检查沿执行节点的长连接发一次最小请求，界面显示往返延迟，不可达时显示原因。访问
 * 客户端没有这条通道，面板说明这一点。撤销入口放在详情里，撤销之后入口由列表状态决定。
 * @module @chatdsh/client-account/detail
 */

import { useState } from 'react';
import { Button, Dialog, ErrorNote, StatusLine } from '@chatdsh/core-ui-kit';
import { describeFailure, formatMoment, formatRelative, linkCheckText, platformLabel, ROLE_LABELS } from './describe.ts';
import type { RevokeTarget } from './revoke.tsx';
import type { AccessClient, Device, DeviceGateway, LinkCheck } from './types.ts';

/** 详情对话框的目标。 */
export type DetailTarget =
  | { readonly kind: 'node'; readonly record: Device }
  | { readonly kind: 'access'; readonly record: AccessClient };

/** 详情对话框属性。 */
export interface DeviceDetailDialogProps {
  readonly gateway: DeviceGateway;
  readonly target: DetailTarget;
  readonly onClose: () => void;
  readonly onRevoke: (target: RevokeTarget) => void;
}

/** 当前设备标记的文案。 */
function currentLabelOf(target: DetailTarget): string {
  if (target.kind === 'node') return target.record.currentExecutor ? '当前执行设备' : '不是当前执行设备';
  return target.record.current ? '当前客户端' : '不是当前客户端';
}

/**
 * 把详情目标折成撤销确认需要的信息。
 * @param target - 详情目标。
 * @returns 撤销目标。
 */
export function revokeTargetOf(target: DetailTarget): RevokeTarget {
  return {
    id: target.record.id,
    name: target.record.name,
    platform: target.record.platform,
    kindLabel: target.kind === 'node' ? ROLE_LABELS[target.record.role] : '访问客户端',
  };
}

/**
 * 设备详情对话框。
 * @param props - 数据入口、目标与回调。
 * @returns 对话框。
 */
export function DeviceDetailDialog({ gateway, target, onClose, onRevoke }: DeviceDetailDialogProps) {
  const record = target.record;
  const node = target.kind === 'node' ? target.record : undefined;
  const [check, setCheck] = useState<LinkCheck | undefined>(undefined);
  const [checking, setChecking] = useState(false);
  const [checkFailure, setCheckFailure] = useState<string | undefined>(undefined);
  const now = Date.now();
  const revoked = record.revokedAt !== undefined;
  const canCheck = target.kind === 'node' && !revoked;

  const runCheck = (): void => {
    if (checking) return;
    setChecking(true);
    setCheckFailure(undefined);
    gateway.checkLink(record.id).then(
      (result) => {
        setChecking(false);
        setCheck(result);
        gateway.noteAction('device-link-check', result.reachable ? 'ok' : 'failed');
      },
      (error: unknown) => {
        setChecking(false);
        setCheckFailure(describeFailure(error));
        gateway.noteAction('device-link-check', 'failed');
      },
    );
  };

  return (
    <Dialog open title="设备详情" description="配对时刻、角色、当前设备标记与链路检查结果都在这里。" onClose={onClose}>
      <dl data-device-facts>
        <dt>名称</dt>
        <dd data-device-detail-name>{record.name}</dd>
        <dt>平台</dt>
        <dd>{platformLabel(record.platform)}</dd>
        <dt>角色</dt>
        <dd>{node === undefined ? '访问客户端' : ROLE_LABELS[node.role]}</dd>
        {node === undefined ? null : (
          <>
            <dt>能力</dt>
            <dd data-device-detail-capabilities>{node.capabilities.length === 0 ? '设备没有上报能力' : node.capabilities.join('、')}</dd>
          </>
        )}
        <dt>配对时间</dt>
        <dd>{formatMoment(record.createdAt)}</dd>
        <dt>最近活动</dt>
        <dd>{`${formatMoment(record.lastSeenAt)}（${formatRelative(record.lastSeenAt, now)}）`}</dd>
        {node === undefined ? null : (
          <>
            <dt>在线状态</dt>
            <dd data-device-detail-online>{node.online ? '在线' : '离线'}</dd>
          </>
        )}
        <dt>当前设备</dt>
        <dd data-device-detail-current>{currentLabelOf(target)}</dd>
        {record.revokedAt === undefined ? null : (
          <>
            <dt>撤销时刻</dt>
            <dd data-device-detail-revoked>{formatMoment(record.revokedAt)}</dd>
          </>
        )}
      </dl>
      <section aria-labelledby="chdsh-device-link-title" data-link-check>
        <h3 id="chdsh-device-link-title">链路检查</h3>
        {target.kind === 'node' ? null : <StatusLine>链路检查只针对执行节点，访问客户端没有这条通道。</StatusLine>}
        {target.kind === 'node' && revoked ? <StatusLine>这台设备已撤销，控制平面不再执行链路检查。</StatusLine> : null}
        {canCheck ? (
          <Button id="chdsh-device-link-check" aria-busy={checking} onClick={runCheck}>
            {checking ? '正在检查…' : '检查链路'}
          </Button>
        ) : null}
        {checkFailure === undefined ? null : <ErrorNote>{checkFailure}</ErrorNote>}
        {check === undefined ? null : <p data-link-result>{linkCheckText(check)}</p>}
      </section>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--cdh-s2)' }}>
        {revoked ? null : (
          <Button id="chdsh-device-detail-revoke" tone="danger" onClick={() => onRevoke(revokeTargetOf(target))}>
            撤销这台设备
          </Button>
        )}
        <Button id="chdsh-device-detail-close" onClick={onClose}>关闭详情</Button>
      </div>
    </Dialog>
  );
}
