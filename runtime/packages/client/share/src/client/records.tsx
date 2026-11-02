/**
 * 分享记录：状态、剩余有效期、访问次数、占用字节、总量统计与撤销。
 *
 * 每一行先判定能否产生可访问链接：撤销、过期、快照内容缺失、附件副本不完整与缺少公开路径
 * 的记录都只说明原因，复制与打开两个动作不出现。撤销需要二次确认，并以控制平面的返回与
 * 公开页的应答为准。复制失败时保留可选择的链接文本，不假装复制成功。
 * @module @chatdsh/client-share/records
 */

import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Dialog, EmptyState, ErrorNote, List, Panel, Row, Skeleton, StatusLine } from '@chatdsh/core-ui-kit';
import { copyText, type CopyOutcome } from './copy.ts';
import { availabilityOf, describeBytes, formatTime, shareUrlOf, statsOf, type RecordAvailability } from './share.ts';
import type { Loadable } from './loadable.ts';
import type { ShareGateway, ShareList, ShareRecordView } from './types.ts';

/** 可访问结论对应的徽标色调。 */
const TONE_OF: Readonly<Record<RecordAvailability['kind'], 'ok' | 'neutral' | 'warn' | 'danger'>> = {
  active: 'ok',
  revoked: 'neutral',
  expired: 'warn',
  'missing-content': 'danger',
  'missing-package': 'danger',
  'no-path': 'danger',
};

/** 记录面板属性。 */
export interface ShareRecordsPanelProps {
  readonly gateway: ShareGateway;
  readonly shares: Loadable<ShareList>;
  readonly onReload: () => void;
}

/** 复制状态。 */
interface CopyState {
  readonly shareId: string;
  readonly url: string;
  readonly outcome: CopyOutcome;
}

/** 页面来源。 */
function originOf(): string {
  return typeof location === 'undefined' ? 'http://127.0.0.1' : location.origin;
}

/**
 * 分享记录面板。
 * @param props - 数据入口、记录与刷新回调。
 * @returns 面板。
 */
export function ShareRecordsPanel({ gateway, shares, onReload }: ShareRecordsPanelProps) {
  const [revoking, setRevoking] = useState<ShareRecordView | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [copied, setCopied] = useState<CopyState | undefined>(undefined);
  const fallback = useRef<HTMLInputElement>(null);
  const now = Date.now();

  // 复制被拒绝时把焦点放到替代文本上，用户按键就能整段选中。
  useEffect(() => {
    if (copied === undefined || copied.outcome.ok) return;
    fallback.current?.select();
  }, [copied]);

  if (shares.status === 'loading') return <Panel title="分享记录"><Skeleton rows={3} /></Panel>;
  if (shares.status === 'failed') {
    return (
      <Panel title="分享记录">
        <ErrorNote>分享记录不可用：{shares.error instanceof Error ? shares.error.message : String(shares.error)}</ErrorNote>
        <Button id="chdsh-share-records-reload" onClick={onReload}>重新读取</Button>
      </Panel>
    );
  }
  if (shares.value.shares.length === 0) {
    return (
      <Panel title="分享记录">
        <EmptyState>还没有分享链接。在「创建分享」里选一条会话建立第一条。</EmptyState>
      </Panel>
    );
  }

  const stats = statsOf(shares.value.shares, shares.value.totalBytes, now);

  return (
    <Panel title="分享记录" count={`${String(stats.count)} 条`} subtitle="列表只显示会话名称、状态、时间、访问次数与占用字节；内部序号与副本水位不出现在这里。">
      <div data-share-stats>
        <StatusLine>
          {`共 ${String(stats.count)} 条 · 可访问 ${String(stats.active)} 条 · 访问合计 ${String(stats.visits)} 次 · 占用合计 ${describeBytes(stats.bytes)}`}
        </StatusLine>
      </div>
      {notice === undefined ? null : <StatusLine>{notice}</StatusLine>}
      <List>
        {shares.value.shares.map((record) => {
          const availability = availabilityOf(record, now);
          const url = record.path === undefined ? undefined : shareUrlOf(originOf(), record.path);
          return (
            <Row
              key={record.shareId}
              dot={availability.linkable ? 'ok' : availability.kind === 'expired' ? 'warn' : 'idle'}
              title={<span data-share-id={record.shareId}>{record.title}</span>}
              badge={<Badge tone={TONE_OF[availability.kind]}>{availability.label}</Badge>}
              meta={`${availability.detail} · 建立于 ${formatTime(record.createdAt)} · 访问 ${String(record.visits)} 次 · 占用 ${describeBytes(record.bytes)}`}
              actions={availability.linkable && url !== undefined ? (
                <>
                  <Button
                    id={`chdsh-share-copy-${record.shareId}`}
                    aria-label={`复制分享链接：${record.title}`}
                    onClick={() => {
                      void copyText(url).then((outcome) => {
                        setCopied({ shareId: record.shareId, url, outcome });
                        gateway.noteAction('share-copy', outcome.ok ? 'ok' : 'failed');
                      });
                    }}
                  >
                    复制
                  </Button>
                  <a
                    className="chdsh-btn"
                    id={`chdsh-share-open-${record.shareId}`}
                    href={record.path}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`打开公开快照：${record.title}`}
                    onClick={() => gateway.noteAction('share-open', 'ok')}
                  >
                    打开
                  </a>
                  {availability.kind === 'active' ? (
                    <Button id={`chdsh-share-revoke-${record.shareId}`} tone="danger" aria-label={`撤销分享：${record.title}`} onClick={() => setRevoking(record)}>撤销</Button>
                  ) : null}
                </>
              ) : (
                <span data-share-blocked={record.shareId} style={{ color: 'var(--chatdsh-muted)', fontSize: 'var(--cdh-fs-12)', overflowWrap: 'anywhere' }}>
                  不产生可访问链接
                </span>
              )}
            />
          );
        })}
      </List>
      {copied === undefined ? null : (
        <div style={{ marginTop: '8px' }} data-share-copy-state={copied.shareId}>
          {copied.outcome.ok ? (
            <StatusLine>已复制到剪贴板。</StatusLine>
          ) : (
            <>
              <StatusLine tone="danger">{`${copied.outcome.detail}。下面这段文字可以直接选中复制。`}</StatusLine>
              <input
                ref={fallback}
                readOnly
                data-share-copy-text
                aria-label="可手动复制的分享地址"
                value={copied.url}
                onFocus={(event) => event.currentTarget.select()}
                style={{
                  boxSizing: 'border-box',
                  width: '100%',
                  minWidth: 0,
                  minHeight: '44px',
                  padding: 'var(--cdh-s2)',
                  border: '1px solid var(--chatdsh-line-2)',
                  borderRadius: 'var(--cdh-r1)',
                  background: 'var(--chatdsh-panel)',
                  color: 'var(--chatdsh-ink)',
                  fontFamily: 'var(--cdh-font-mono)',
                  fontSize: 'var(--cdh-fs-12)',
                  overflowWrap: 'anywhere',
                }}
              />
            </>
          )}
        </div>
      )}
      {revoking === undefined ? null : (
        <RevokeConfirm
          gateway={gateway}
          record={revoking}
          onClose={() => setRevoking(undefined)}
          onDone={(message) => {
            setRevoking(undefined);
            setNotice(message);
            onReload();
          }}
        />
      )}
    </Panel>
  );
}

/** 撤销的二次确认。 */
function RevokeConfirm({ gateway, record, onClose, onDone }: {
  readonly gateway: ShareGateway;
  readonly record: ShareRecordView;
  readonly onClose: () => void;
  readonly onDone: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);

  const confirm = (): void => {
    if (busy) return;
    setBusy(true);
    setFailure(undefined);
    gateway.revoke(record.shareId).then(
      async (result) => {
        if (!result.revoked) {
          setBusy(false);
          setFailure('控制平面没有撤销这条分享，记录保持原状。');
          gateway.noteAction('share-revoke', 'failed');
          return;
        }
        const probe = await gateway.probe(record.shareId);
        setBusy(false);
        gateway.noteAction('share-revoke', probe.reason === 'active' ? 'degraded' : 'ok');
        onDone(probe.reason === 'active'
          ? '撤销已提交，但公开页当前仍可读取；请稍后重新读取记录确认。'
          : '已撤销，公开页立即返回失效页面。');
      },
      (error: unknown) => {
        setBusy(false);
        setFailure(error instanceof Error ? error.message : String(error));
        gateway.noteAction('share-revoke', 'failed');
      },
    );
  };

  return (
    <Dialog
      open
      title="撤销分享"
      description="撤销之后这条链接立即失效，已经拿到链接的人也读不到内容。源会话本身不受影响。"
      onClose={onClose}
    >
      <p>{`${record.title} · 建立于 ${formatTime(record.createdAt)} · 访问 ${String(record.visits)} 次 · 占用 ${describeBytes(record.bytes)}`}</p>
      {failure === undefined ? null : <ErrorNote>{failure}</ErrorNote>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
        <Button id="chdsh-share-revoke-cancel" onClick={onClose}>取消</Button>
        <Button id="chdsh-share-revoke-confirm" tone="danger" disabled={busy} onClick={confirm}>
          {busy ? '正在撤销…' : '确认撤销'}
        </Button>
      </div>
    </Dialog>
  );
}
