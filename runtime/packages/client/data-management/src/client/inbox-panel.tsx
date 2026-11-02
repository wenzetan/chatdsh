/**
 * 删除收件箱面板。
 *
 * 列出已软删除的会话：标题、原设备、删除时间、剩余保留天数与占用空间。恢复在提交时重新校验
 * 目标存在性与是否过期，结果按控制平面的判定显示成功或拒绝原因。永久删除走两级确认：一级列出
 * 删除范围与释放空间，二级逐项确认分享与记忆组依赖并再次确认不可恢复，执行后重新读取收件箱。
 * @module @chatdsh/client-data-management/inbox-panel
 */

import { Badge, Button, EmptyState, ErrorNote, Panel, Skeleton, StatusLine } from '@chatdsh/core-ui-kit';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ConfirmDialog, type ConfirmDependency } from './confirm-dialog.tsx';
import { callFace, type DataManagementFace } from './face.ts';
import { formatBytes, formatCount, formatTimestamp } from './format.ts';
import { DataCallError, failureOf, failureText, reasonOf, type Loadable } from './errors.ts';
import {
  parseDeletionInbox,
  parsePermanentOutcome,
  parsePermanentScope,
  parseRestoreResult,
  type DeletionInboxItem,
  type PermanentOutcomeView,
  type PermanentScopeView,
  type RestoreResultView,
} from './schemas.ts';
import { browserTelemetry } from './telemetry.ts';

/** 永久删除对象的名称。 */
const OBJECT_LABELS: Readonly<Record<'log' | 'replica' | 'object' | 'share' | 'attachment', string>> = {
  log: '会话日志',
  replica: '控制平面副本',
  object: '对象存储',
  share: '分享记录',
  attachment: '附件',
};

/**
 * 计算一次恢复请求的摘要。
 * @param sessionId - 会话标识。
 * @param operationId - 操作标识。
 * @returns SHA-256 的十六进制文本。
 */
async function digestOf(sessionId: string, operationId: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${sessionId}:${operationId}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 删除收件箱面板的属性。 */
export interface InboxPanelProps {
  /** 数据入口；缺省表示控制平面没有接入。 */
  readonly face?: DataManagementFace;
  /** 收件箱或永久删除结果变化时交给外部，供导出使用。 */
  readonly onLoaded?: (input: {
    readonly items: readonly DeletionInboxItem[];
    readonly restore?: RestoreResultView;
    readonly permanentScope?: PermanentScopeView;
    readonly permanentOutcome?: PermanentOutcomeView;
  }) => void;
}

/**
 * 删除收件箱面板。
 * @param props - 数据入口与回调。
 * @returns 面板内容。
 */
export function InboxPanel({ face, onLoaded }: InboxPanelProps) {
  const [inbox, setInbox] = useState<Loadable<readonly DeletionInboxItem[]>>({ status: 'loading' });
  const [restored, setRestored] = useState<Extract<RestoreResultView, { outcome: 'restored' }> | undefined>(undefined);
  const [restoreRejected, setRestoreRejected] = useState<string | undefined>(undefined);
  const [restoreFailure, setRestoreFailure] = useState<DataCallError | undefined>(undefined);
  const [restoring, setRestoring] = useState<string | undefined>(undefined);
  const [target, setTarget] = useState<DeletionInboxItem | undefined>(undefined);
  const [level, setLevel] = useState<'scope' | 'confirm'>('scope');
  const [scope, setScope] = useState<PermanentScopeView | undefined>(undefined);
  const [scopeFailure, setScopeFailure] = useState<DataCallError | undefined>(undefined);
  const [deleting, setDeleting] = useState(false);
  const [deleteFailure, setDeleteFailure] = useState<DataCallError | undefined>(undefined);
  const [permanentOutcome, setPermanentOutcome] = useState<PermanentOutcomeView | undefined>(undefined);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async (): Promise<void> => {
    if (face?.inbox === undefined) {
      if (alive.current) setInbox({ status: 'unavailable' });
      return;
    }
    try {
      const items = await callFace('读取删除收件箱', () => face.inbox!(), parseDeletionInbox);
      if (!alive.current) return;
      setInbox({ status: 'ready', value: items });
      browserTelemetry.action('data-inbox-read', 'ok');
      onLoaded?.({ items });
    } catch (error) {
      if (!alive.current) return;
      setInbox({ status: 'failed', failure: failureOf(error) });
      browserTelemetry.action('data-inbox-read', 'failed');
    }
  }, [face, onLoaded]);

  useEffect(() => {
    void load();
  }, [load]);

  const restoreItem = async (item: DeletionInboxItem): Promise<void> => {
    setRestored(undefined);
    setRestoreRejected(undefined);
    setRestoreFailure(undefined);
    if (face?.restore === undefined) {
      setRestoreFailure(failureOf(new Error('控制平面没有提供恢复接口')));
      browserTelemetry.action('data-restore', 'failed');
      return;
    }
    setRestoring(item.sessionId);
    try {
      const operationId = crypto.randomUUID();
      const requestDigest = await digestOf(item.sessionId, operationId);
      const value = await callFace(
        '恢复会话',
        () => face.restore!({ sessionId: item.sessionId, operationId, requestDigest }),
        parseRestoreResult,
      );
      if (!alive.current) return;
      browserTelemetry.action('data-restore', value.outcome === 'restored' ? 'ok' : 'failed');
      if (value.outcome === 'restored') {
        setRestored(value);
        onLoaded?.({
          items: inbox.status === 'ready' ? inbox.value : [],
          restore: value,
        });
        await load();
      } else {
        setRestoreRejected(value.code);
      }
    } catch (error) {
      if (!alive.current) return;
      setRestoreFailure(failureOf(error));
      browserTelemetry.action('data-restore', 'failed');
    } finally {
      if (alive.current) setRestoring(undefined);
    }
  };

  const openPermanent = async (item: DeletionInboxItem): Promise<void> => {
    setTarget(item);
    setLevel('scope');
    setScope(undefined);
    setScopeFailure(undefined);
    setDeleteFailure(undefined);
    setPermanentOutcome(undefined);
    if (face?.permanentScope === undefined) {
      setScopeFailure(failureOf(new Error('控制平面没有提供永久删除范围接口')));
      return;
    }
    try {
      const value = await callFace('读取永久删除范围', () => face.permanentScope!(item.sessionId), parsePermanentScope);
      if (!alive.current) return;
      setScope(value);
      onLoaded?.({
        items: inbox.status === 'ready' ? inbox.value : [],
        permanentScope: value,
        ...(permanentOutcome === undefined ? {} : { permanentOutcome }),
      });
    } catch (error) {
      if (!alive.current) return;
      setScopeFailure(failureOf(error));
    }
  };

  const confirmPermanent = async (): Promise<void> => {
    if (target === undefined || face?.permanentDelete === undefined) return;
    const dependencies = scope?.dependencies ?? [];
    setDeleting(true);
    setDeleteFailure(undefined);
    try {
      const value = await callFace(
        '永久删除会话',
        () => face.permanentDelete!({
          sessionId: target.sessionId,
          confirm: true,
          confirmDependencies: dependencies.length > 0,
        }),
        parsePermanentOutcome,
      );
      if (!alive.current) return;
      setPermanentOutcome(value);
      browserTelemetry.action('data-permanent-delete', 'ok');
      onLoaded?.({
        items: inbox.status === 'ready' ? inbox.value : [],
        ...(scope === undefined ? {} : { permanentScope: scope }),
        permanentOutcome: value,
      });
      setTarget(undefined);
      await load();
    } catch (error) {
      if (!alive.current) return;
      setDeleteFailure(failureOf(error));
      browserTelemetry.action('data-permanent-delete', 'failed');
    } finally {
      if (alive.current) setDeleting(false);
    }
  };

  const dependencies: readonly ConfirmDependency[] = (scope?.dependencies ?? []).map((item, index) => ({
    id: `${item.kind}-${String(index)}`,
    label: item.kind === 'share' ? `分享依赖：${item.label}` : `记忆组引用：${item.label}`,
    ...(item.kind === 'share'
      ? {
        detail: `建立于 ${item.createdAt === undefined ? '未知时刻' : formatTimestamp(item.createdAt)}，访问 ${formatCount(item.visits ?? 0, '次')}`,
      }
      : {}),
  }));

  const facts = [
    { label: '会话', value: target?.sessionId ?? '' },
    { label: '标题', value: target?.title ?? '' },
    { label: '原设备', value: target?.originDeviceId ?? '' },
    { label: '删除时间', value: target === undefined ? '' : formatTimestamp(target.deletedAt) },
    {
      label: '删除对象',
      value: scope === undefined ? '正在读取范围' : scope.objects.map((item) => OBJECT_LABELS[item]).join('、'),
    },
    { label: '释放空间', value: scope === undefined ? '正在读取范围' : formatBytes(scope.bytes) },
    { label: '有效分享依赖', value: scope === undefined ? '正在读取范围' : formatCount(scope.dependentShares, '个') },
  ];

  const impacts = [
    '永久删除之后无法恢复，收件箱里不再有这个条目。',
    '设备权威日志与工作区文件保留在源设备上，不受这次删除影响。',
    '依赖这个会话的分享链接与记忆组引用会失去内容来源。',
  ];

  return (
    <Panel title="删除收件箱" subtitle="已删除的会话按保留期保留。恢复与永久删除都在提交时重新校验目标与依赖。">
      {inbox.status === 'loading' ? <Skeleton rows={3} /> : null}
      {inbox.status === 'unavailable' ? <EmptyState>控制平面没有提供删除收件箱接口。</EmptyState> : null}
      {inbox.status === 'failed'
        ? (
          <div>
            <ErrorNote>{`读取删除收件箱失败：${failureText(inbox.failure)}`}</ErrorNote>
            <Button onClick={() => { void load(); }}>重新读取</Button>
          </div>
        )
        : null}
      {inbox.status === 'ready'
        ? (inbox.value.length === 0
          ? <EmptyState>收件箱是空的。</EmptyState>
          : (
            <table data-inbox>
              <caption>待删除的会话</caption>
              <thead>
                <tr>
                  <th scope="col">标题</th>
                  <th scope="col">原设备</th>
                  <th scope="col">删除时间</th>
                  <th scope="col">剩余保留</th>
                  <th scope="col">占用空间</th>
                  <th scope="col">依赖</th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {inbox.value.map((item) => (
                  <tr key={item.sessionId} data-inbox-item={item.sessionId}>
                    <th scope="row">{item.title}</th>
                    <td>{item.originDeviceId}</td>
                    <td>{formatTimestamp(item.deletedAt)}</td>
                    <td data-inbox-remaining>{`${String(item.remainingDays)} 天`}</td>
                    <td data-inbox-bytes data-bytes={item.bytes}>{formatBytes(item.bytes)}</td>
                    <td>{item.hasShareDependency ? <Badge tone="warn">有有效分享依赖</Badge> : '没有依赖'}</td>
                    <td>
                      <Button
                        data-inbox-restore={item.sessionId}
                        disabled={!item.restorable || restoring === item.sessionId}
                        onClick={() => { void restoreItem(item); }}
                      >
                        {restoring === item.sessionId ? '正在恢复…' : '恢复会话'}
                      </Button>
                      <Button data-inbox-permanent={item.sessionId} tone="danger" onClick={() => { void openPermanent(item); }}>
                        查看删除范围
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))
        : null}
      {restored === undefined ? null : (
        <div data-inbox-restored>
          <StatusLine>{`已恢复 ${restored.sessionId}，恢复时刻 ${formatTimestamp(restored.restoredAt)}。`}</StatusLine>
          <StatusLine>{`恢复的内容范围：第 ${String(restored.scope.turnFrom)} 到 ${String(restored.scope.turnTo)} 回合 · ${formatCount(restored.scope.eventCount, '个事件')} · ${formatCount(restored.scope.charCount, '个字符')}`}</StatusLine>
        </div>
      )}
      {restoreRejected === undefined ? null : (
        <div data-inbox-restore-rejected>
          <ErrorNote>{`恢复被拒绝：${reasonOf(restoreRejected)}（错误码 ${restoreRejected}）`}</ErrorNote>
        </div>
      )}
      {restoreFailure === undefined ? null : (
        <div data-inbox-restore-failed>
          <ErrorNote>{`恢复失败：${failureText(restoreFailure)}`}</ErrorNote>
        </div>
      )}
      {permanentOutcome === undefined ? null : (
        <div data-inbox-permanent-outcome>
          <h3>永久删除结果</h3>
          <dl>
            <div><dt>会话</dt><dd>{permanentOutcome.sessionId}</dd></div>
            <div><dt>释放空间</dt><dd data-permanent-released data-bytes={permanentOutcome.releasedBytes}>{formatBytes(permanentOutcome.releasedBytes)}</dd></div>
            <div><dt>删除的事件行</dt><dd>{formatCount(permanentOutcome.removedEvents, '个')}</dd></div>
            <div><dt>删除的分享记录</dt><dd>{formatCount(permanentOutcome.removedShares, '个')}</dd></div>
            <div><dt>删除的已读回执</dt><dd>{formatCount(permanentOutcome.removedReceipts, '个')}</dd></div>
            <div><dt>依赖结果</dt><dd>{`有效分享 ${formatCount(permanentOutcome.dependencies.shares, '个')}，记忆组 ${formatCount(permanentOutcome.dependencies.memoryGroups, '个')}`}</dd></div>
          </dl>
          <StatusLine>{permanentOutcome.authoritativeLogsPreserved ? '设备权威日志与工作区文件保留。' : '权威日志状态未知。'}</StatusLine>
        </div>
      )}

      <ConfirmDialog
        open={target !== undefined && level === 'scope'}
        title="永久删除范围"
        description="先核对删除范围与依赖影响，再进入第二级确认。"
        facts={facts}
        impacts={impacts}
        dependencies={dependencies}
        requireDependencyConfirm={false}
        busy={false}
        confirmLabel="继续确认"
        onClose={() => {
          setTarget(undefined);
        }}
        onConfirm={() => {
          setLevel('confirm');
        }}
      />
      {scopeFailure === undefined ? null : <ErrorNote>{`读取永久删除范围失败：${failureText(scopeFailure)}`}</ErrorNote>}
      <ConfirmDialog
        open={target !== undefined && level === 'confirm'}
        title="确认永久删除"
        description="这一级确认要求逐项确认依赖影响，并再次确认不可恢复。"
        facts={facts}
        impacts={impacts}
        dependencies={dependencies}
        acknowledgeLabel="已经了解永久删除不可恢复；设备权威日志与工作区文件保留在源设备上"
        confirmLabel="永久删除"
        busy={deleting}
        {...(deleteFailure === undefined ? {} : { failure: `永久删除失败：${failureText(deleteFailure)}` })}
        onClose={() => {
          setTarget(undefined);
        }}
        onConfirm={() => { void confirmPermanent(); }}
      />
    </Panel>
  );
}
