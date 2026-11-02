/**
 * 访问会话列表。
 *
 * 每一行显示客户端名称、建立时间、最近活动、到期时间与续期窗口起点，当前会话用标记标出。
 * 单条撤销与全部撤销都经过确认对话框，对话框约束焦点并在关闭后把焦点交回触发按钮。撤销全部
 * 会话之前需要再次认证，界面说明认证窗口与影响；撤销当前会话之后页面回到登录入口。
 * @module @chatdsh/client-access/sessions
 */

import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Dialog, ErrorNote, List, Panel, Row, Skeleton, StatusLine } from '@chatdsh/core-ui-kit';
import { describeAccessFailure, formatMoment, formatRelative } from './describe.ts';
import { createAccessGateway } from './gateway.ts';
import { REAUTH_WINDOW_SECONDS } from './reauth.tsx';
import type { AccessGateway, AccessSensitiveAction, AccessSession, AccessSessionList, Loadable } from './types.ts';
import { useNow } from './use-now.ts';

/** 会话列表面板属性。 */
export interface SessionsPanelProps {
  /** 数据入口。 */
  readonly gateway?: AccessGateway;
  /** 全部撤销之前的再次认证；返回 `false` 表示取消。 */
  readonly guard?: (action: AccessSensitiveAction) => Promise<boolean>;
  /** 撤销当前会话之后的回调。 */
  readonly onSignedOut?: () => void;
}

let sharedGateway: AccessGateway | undefined;

/**
 * 取数据入口。
 * @param provided - 调用方传入的入口。
 * @returns 数据入口。
 */
function gatewayOf(provided?: AccessGateway): AccessGateway {
  if (provided !== undefined) return provided;
  sharedGateway ??= createAccessGateway();
  return sharedGateway;
}

/**
 * 一条访问会话的行。
 * @param props - 记录、当前时刻与撤销回调。
 * @returns 列表行。
 */
function SessionRow({ record, now, onRevoke }: {
  readonly record: AccessSession;
  readonly now: number;
  readonly onRevoke: (record: AccessSession) => void;
}) {
  const revoked = record.revokedAt !== undefined;
  return (
    <Row
      dot={revoked ? 'idle' : record.current ? 'ok' : 'warn'}
      title={<span data-session-client={record.sessionId}>{record.clientName}</span>}
      badge={(
        <>
          {record.current ? <Badge tone="brand">当前设备</Badge> : null}
          {revoked ? <Badge tone="danger">已撤销</Badge> : <Badge tone="neutral">有效</Badge>}
        </>
      )}
      meta={(
        <span data-session-meta={record.sessionId}>
          {`建立于 ${formatMoment(record.createdAt)} · 最近活动 ${formatRelative(record.lastActiveAt, now)} · 到期 ${formatMoment(record.expiresAt)} · 续期窗口从 ${formatMoment(record.renewableFrom)} 起`}
        </span>
      )}
      actions={revoked ? null : (
        <Button
          id={`chdsh-access-session-revoke-${record.sessionId}`}
          tone="danger"
          aria-label={`撤销访问会话：${record.clientName}`}
          onClick={() => onRevoke(record)}
        >
          {record.current ? '退出当前设备' : '撤销'}
        </Button>
      )}
    />
  );
}

/**
 * 访问会话面板。
 * @param props - 数据入口、再认证与退出回调。
 * @returns 面板内容。
 */
export function SessionsPanel({ gateway, guard, onSignedOut }: SessionsPanelProps = {}) {
  const face = gatewayOf(gateway);
  const now = useNow();
  const [list, setList] = useState<Loadable<AccessSessionList>>({ status: 'loading' });
  const [target, setTarget] = useState<AccessSession | undefined>(undefined);
  const [revokingAll, setRevokingAll] = useState<false | 'keep-current' | 'all'>(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  const reload = useCallback((): void => {
    face.sessions().then(
      (value) => {
        setList({ status: 'ready', value });
        face.noteAction('access-sessions', 'ok');
      },
      (error: unknown) => {
        setList({ status: 'failed', error });
        face.noteAction('access-sessions', 'failed');
      },
    );
  }, [face]);

  useEffect(() => {
    reload();
  }, [reload]);

  /** 撤销一条会话。 */
  const revokeOne = (): void => {
    if (target === undefined) return;
    setPending(true);
    setFailure(undefined);
    face.revokeSession(target.sessionId).then(
      () => {
        setPending(false);
        setTarget(undefined);
        setNotice(`已撤销 ${target.clientName} 的访问会话。`);
        face.noteAction('access-session-revoke', 'ok');
        if (target.current) onSignedOut?.();
        else reload();
      },
      (error: unknown) => {
        setPending(false);
        setFailure(describeAccessFailure(error));
        face.noteAction('access-session-revoke', 'failed');
      },
    );
  };

  /**
   * 撤销一批会话。
   * @param keepCurrent - 是否保留当前会话。
   */
  const revokeAll = (keepCurrent: boolean): void => {
    setPending(true);
    setFailure(undefined);
    setRevokingAll(false);
    const proceed = guard === undefined ? Promise.resolve(true) : guard('revoke-all-sessions');
    proceed.then(async (authorized) => {
      if (!authorized) {
        setPending(false);
        setNotice('已取消撤销访问会话。');
        return;
      }
      try {
        const result = await face.revokeAllSessions(keepCurrent);
        setPending(false);
        setNotice(keepCurrent
          ? `已退出其他客户端，撤销 ${String(result.revokedCount)} 条访问会话。`
          : `已撤销全部访问会话，共 ${String(result.revokedCount)} 条。`);
        face.noteAction('access-sessions-revoke-all', 'ok');
        if (keepCurrent) reload();
        else onSignedOut?.();
      } catch (error) {
        setPending(false);
        setFailure(describeAccessFailure(error));
        face.noteAction('access-sessions-revoke-all', 'failed');
      }
    });
  };

  if (list.status === 'failed') {
    return (
      <Panel title="访问会话">
        <ErrorNote>{`访问会话读取失败：${describeAccessFailure(list.error)}`}</ErrorNote>
        <Button id="chdsh-access-sessions-reload" onClick={reload}>重新读取</Button>
      </Panel>
    );
  }
  if (list.status === 'loading') {
    return <Panel title="访问会话"><Skeleton rows={3} /></Panel>;
  }

  const sessions = list.value.items;
  const active = sessions.filter((record) => record.revokedAt === undefined);
  return (
    <Panel title="访问会话" subtitle="每一行是一台已经登录的设备。撤销之后该设备立即退出。" count={`${String(active.length)} 条有效`}>
      {notice === undefined ? null : <StatusLine>{notice}</StatusLine>}
      {failure === undefined ? null : <ErrorNote>{failure}</ErrorNote>}
      <div style={{ display: 'flex', gap: 'var(--cdh-s2)', justifyContent: 'flex-end', marginBottom: 'var(--cdh-s2)', flexWrap: 'wrap' }}>
        <Button id="chdsh-access-sessions-refresh" onClick={reload}>刷新列表</Button>
        <Button id="chdsh-access-sessions-revoke-others" tone="danger" disabled={pending || active.length <= 1} onClick={() => setRevokingAll('keep-current')}>
          退出其他客户端
        </Button>
        <Button id="chdsh-access-sessions-revoke-all" tone="danger" disabled={pending || active.length === 0} onClick={() => setRevokingAll('all')}>
          退出全部客户端
        </Button>
      </div>
      {sessions.length === 0 ? (
        <StatusLine>还没有访问会话记录。</StatusLine>
      ) : (
        <List>
          {sessions.map((record) => (
            <SessionRow key={record.sessionId} record={record} now={now} onRevoke={setTarget} />
          ))}
        </List>
      )}

      <Dialog
        open={target !== undefined}
        title="撤销这条访问会话"
        description="撤销之后该设备的访问会话立即失效，需要重新登录。已经写入的业务草稿与内容保持在原处。"
        onClose={() => setTarget(undefined)}
      >
        <p>{target === undefined ? '' : `${target.clientName}，建立于 ${formatMoment(target.createdAt)}。`}</p>
        <div style={{ display: 'flex', gap: 'var(--cdh-s2)', justifyContent: 'flex-end' }}>
          <Button id="chdsh-access-session-revoke-cancel" onClick={() => setTarget(undefined)}>取消</Button>
          <Button id="chdsh-access-session-revoke-confirm" tone="danger" disabled={pending} onClick={revokeOne}>撤销会话</Button>
        </div>
      </Dialog>

      <Dialog
        open={revokingAll !== false}
        title={revokingAll === 'keep-current' ? '退出其他客户端' : '退出全部客户端'}
        description={`撤销之前需要再次认证。再次认证的有效窗口是 ${String(REAUTH_WINDOW_SECONDS / 60)} 分钟，本次认证只用于这一个动作。`}
        onClose={() => setRevokingAll(false)}
      >
        <p>
          {revokingAll === 'keep-current'
            ? '当前设备的会话会保留，其余客户端的访问会话全部撤销。'
            : '包括当前设备在内的全部访问会话都会撤销，页面会回到登录入口。'}
        </p>
        <div style={{ display: 'flex', gap: 'var(--cdh-s2)', justifyContent: 'flex-end' }}>
          <Button id="chdsh-access-sessions-revoke-all-cancel" onClick={() => setRevokingAll(false)}>取消</Button>
          <Button id="chdsh-access-sessions-revoke-all-confirm" tone="danger" disabled={pending} onClick={() => revokeAll(revokingAll === 'keep-current')}>
            {revokingAll === 'keep-current' ? '再次认证并退出其他客户端' : '再次认证并退出全部客户端'}
          </Button>
        </div>
      </Dialog>
    </Panel>
  );
}
