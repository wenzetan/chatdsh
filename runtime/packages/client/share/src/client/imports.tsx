/**
 * 导入：把另一台设备的会话副本还原成本机的一条新会话。
 *
 * 导入走控制平面的真实接口：源会话的副本原样写进新会话，新会话记 `parentSession`，旧工具
 * 调用不会重新执行。提交之前先读一次副本并逐条校验形状，形状不合法或者没有可读副本时列出
 * 具体原因，不进入创建步骤。导入成功后跳转到新会话对应的逻辑路由。
 * @module @chatdsh/client-share/imports
 */

import { useState } from 'react';
import { Button, ErrorNote, Field, Panel, StatusLine } from '@chatdsh/core-ui-kit';
import { formatTime, validateReplicaEvents, type ImportValidation } from './share.ts';
import type { Loadable } from './loadable.ts';
import type { SessionsSnapshot, ShareGateway } from './types.ts';

/** 导入面板属性。 */
export interface ImportPanelProps {
  readonly gateway: ShareGateway;
  readonly sessions: Loadable<SessionsSnapshot>;
}

/** 读取并校验的结论。 */
type Checked =
  | { readonly kind: 'invalid'; readonly failures: readonly string[] }
  | { readonly kind: 'ready'; readonly validation: ImportValidation };

/**
 * 导入面板。
 * @param props - 数据入口与会话列表。
 * @returns 面板。
 */
export function ImportPanel({ gateway, sessions }: ImportPanelProps) {
  const [sourceId, setSourceId] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [cwd, setCwd] = useState('');
  const [checked, setChecked] = useState<Checked | undefined>(undefined);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  if (sessions.status === 'loading') return <Panel title="导入会话"><StatusLine>正在读取会话列表…</StatusLine></Panel>;
  if (sessions.status === 'failed') {
    return (
      <Panel title="导入会话">
        <ErrorNote>会话列表不可用，无法选择导入源：{sessions.error instanceof Error ? sessions.error.message : String(sessions.error)}</ErrorNote>
      </Panel>
    );
  }

  const devices = sessions.value.devices;
  const sources = devices.flatMap((device) => device.sessions.map((session) => ({ device, session })));
  const selected = sources.find((entry) => entry.session.sessionId === sourceId);

  /** 读取源会话副本并校验。 */
  const check = (): void => {
    if (busy) return;
    if (sourceId === '') {
      setFailure('请先选择源会话');
      return;
    }
    setBusy(true);
    setFailure(undefined);
    setChecked(undefined);
    gateway.replica(sourceId).then(
      (snapshot) => {
        const validation = validateReplicaEvents(snapshot.events);
        setBusy(false);
        if (!validation.ok) {
          gateway.noteAction('share-import-preview', 'failed');
          setChecked({
            kind: 'invalid',
            failures: validation.failures.slice(0, 8).map((item) => `${item.message}（${item.code}）`),
          });
          return;
        }
        if (validation.events.length === 0) {
          gateway.noteAction('share-import-preview', 'failed');
          setChecked({ kind: 'invalid', failures: ['源会话没有可读副本，无法导入。请确认源设备已经同步过这条会话。'] });
          return;
        }
        gateway.noteAction('share-import-preview', 'ok');
        setChecked({ kind: 'ready', validation });
      },
      (error: unknown) => {
        setBusy(false);
        setFailure(error instanceof Error ? error.message : String(error));
        gateway.noteAction('share-import-preview', 'failed');
      },
    );
  };

  /** 提交导入；成功后跳到新会话的逻辑路由。 */
  const submit = (): void => {
    if (busy) return;
    setBusy(true);
    setFailure(undefined);
    gateway.importSession({
      sourceSessionId: sourceId,
      ...(deviceId === '' ? {} : { deviceId }),
      ...(cwd === '' ? {} : { cwd }),
    }).then(
      (created) => {
        setBusy(false);
        gateway.noteAction('share-import', 'ok');
        const query = deviceId === '' ? '' : `?device=${encodeURIComponent(deviceId)}`;
        location.assign(`/sessions/${encodeURIComponent(created.sessionId)}${query}`);
      },
      (error: unknown) => {
        setBusy(false);
        setFailure(error instanceof Error ? error.message : String(error));
        gateway.noteAction('share-import', 'failed');
      },
    );
  };

  return (
    <Panel title="导入会话" subtitle="导入把源会话的副本写成本机的一条新会话；旧工具调用不会重新执行。">
      <Field label="源会话" required help={selected === undefined ? '列出所有设备上的会话。' : `源设备：${selected.device.name}（${selected.device.online ? '在线' : '离线'}）· 最近活动 ${formatTime(selected.session.updatedAt)}`}>
        <select
          id="chdsh-share-import-source"
          value={sourceId}
          onChange={(event) => {
            const next = event.currentTarget.value;
            setSourceId(next);
            setChecked(undefined);
            setFailure(undefined);
            const picked = sources.find((entry) => entry.session.sessionId === next);
            setCwd(picked?.session.cwd ?? '');
          }}
        >
          <option value="">选择一条会话</option>
          {sources.map((entry) => (
            <option key={`${entry.device.deviceId}/${entry.session.sessionId}`} value={entry.session.sessionId}>
              {`${entry.session.title}（${entry.device.name}）`}
            </option>
          ))}
        </select>
      </Field>
      <Field label="目标设备" help="新会话记在这台设备名下；缺省记在发起请求的浏览器设备名下。">
        <select id="chdsh-share-import-device" value={deviceId} onChange={(event) => setDeviceId(event.currentTarget.value)}>
          <option value="">发起导入的浏览器设备</option>
          {devices.map((device) => (
            <option key={device.deviceId} value={device.deviceId}>{`${device.name}（${device.online ? '在线' : '离线'}）`}</option>
          ))}
        </select>
      </Field>
      <Field label="目标目录" help="新会话使用这个工作目录；留空时沿用源会话的目录。">
        <input id="chdsh-share-import-cwd" value={cwd} onChange={(event) => setCwd(event.currentTarget.value)} />
      </Field>
      <StatusLine>控制平面的导入接口按整份副本导入，不提供范围参数；导入内容的范围就是源会话的完整副本。</StatusLine>
      {failure === undefined ? null : <ErrorNote>{failure}</ErrorNote>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
        <Button id="chdsh-share-import-check" disabled={busy} onClick={check}>
          {busy ? '正在读取副本…' : '读取并校验副本'}
        </Button>
        {checked?.kind !== 'ready' ? null : (
          <Button id="chdsh-share-import-confirm" tone="primary" disabled={busy} onClick={submit}>
            {busy ? '正在创建会话…' : '确认创建关联会话'}
          </Button>
        )}
      </div>
      {checked?.kind === 'invalid' ? (
        <div data-import-invalid>
          <ErrorNote>副本校验失败，导入已中止。原因如下：</ErrorNote>
          <ul>
            {checked.failures.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </div>
      ) : null}
      {checked?.kind === 'ready' ? (
        <div data-import-ready>
          <StatusLine>
            {`校验通过：${String(checked.validation.events.length)} 条事件、${String(checked.validation.turns)} 个完整回合、${String(checked.validation.characters)} 个字符。`}
          </StatusLine>
          <StatusLine>确认之后新会话立即建立，并跳转到它的逻辑路由。</StatusLine>
        </div>
      ) : null}
    </Panel>
  );
}
