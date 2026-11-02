/**
 * 撤销确认：二次确认说明立即关闭的通道与保留的内容。
 *
 * 撤销之后控制平面立即关闭这台设备的设备长连接、WebSocket 通道、SSE 流与在途 HTTP 请求，
 * 历史会话与副本记录保留。确认按控制平面的返回收尾：成功与「已经撤销过」都刷新列表，
 * 其他失败留在对话框里说明原因。
 * @module @chatdsh/client-account/revoke
 */

import { useState } from 'react';
import { Button, Dialog, ErrorNote, StatusLine } from '@chatdsh/core-ui-kit';
import { describeFailure, platformLabel } from './describe.ts';
import { DeviceCallError } from './gateway.ts';
import type { DeviceGateway } from './types.ts';

/** 撤销目标。 */
export interface RevokeTarget {
  readonly id: string;
  readonly name: string;
  readonly platform: string;
  /** 角色或「访问客户端」。 */
  readonly kindLabel: string;
}

/** 撤销对话框属性。 */
export interface RevokeDialogProps {
  readonly gateway: DeviceGateway;
  readonly target: RevokeTarget;
  readonly onClose: () => void;
  /** 撤销结束后的回调；参数是给区段的提示，列表由调用方重新读取。 */
  readonly onDone: (message: string) => void;
}

/**
 * 撤销确认对话框。
 * @param props - 数据入口、目标与回调。
 * @returns 对话框。
 */
export function RevokeDialog({ gateway, target, onClose, onDone }: RevokeDialogProps) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);

  const confirm = (): void => {
    if (busy) return;
    setBusy(true);
    setFailure(undefined);
    gateway.revoke(target.id, 'user').then(
      (result) => {
        gateway.noteAction('device-revoke', 'ok');
        onDone(`已撤销 ${target.name}：关闭了 ${String(result.closedLinks)} 条通道，会话与副本记录保留。`);
      },
      (error: unknown) => {
        gateway.noteAction('device-revoke', 'failed');
        if (error instanceof DeviceCallError && error.code === 'already-handled') {
          onDone(`${target.name} 已经撤销过，列表已经刷新。`);
          return;
        }
        setBusy(false);
        setFailure(describeFailure(error));
      },
    );
  };

  return (
    <Dialog
      open
      title="撤销设备"
      description="撤销之后，这台设备的全部通道立即关闭，重新加入需要新的配对码。"
      onClose={onClose}
    >
      <p data-revoke-target>{`${target.name} · ${platformLabel(target.platform)} · ${target.kindLabel}`}</p>
      <h3>立即关闭</h3>
      <ul data-revoke-closed>
        <li>设备长连接：执行节点与访问客户端的实时通道关闭，新的连接在握手阶段被拒绝。</li>
        <li>WebSocket 通道与 SSE 流：正在传输的实时数据立即停止。</li>
        <li>在途 HTTP 请求：尚未返回的请求以撤销结束。</li>
        <li>正在这台设备上运行的会话会中断，未完成的回合不会继续。</li>
      </ul>
      <h3>保留内容</h3>
      <ul data-revoke-preserved>
        <li>历史会话记录保留，其他设备仍可打开与阅读。</li>
        <li>会话副本保留，离线阅读与在本机继续都按副本进行。</li>
        <li>设备登记记录保留，撤销时刻在详情里可查。</li>
      </ul>
      {failure === undefined ? null : <ErrorNote>{failure}</ErrorNote>}
      {busy ? <StatusLine>正在撤销…</StatusLine> : null}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--cdh-s2)' }}>
        <Button id="chdsh-device-revoke-cancel" onClick={onClose}>取消</Button>
        <Button id="chdsh-device-revoke-confirm" tone="danger" disabled={busy} onClick={confirm}>
          {busy ? '正在撤销…' : '确认撤销'}
        </Button>
      </div>
    </Dialog>
  );
}
