/**
 * 自动化列表：名称、启用状态、触发条件摘要、最近投递状态与行内操作。
 *
 * 读失败显示原因与重试按钮，读到空列表显示空状态与新建入口，两者不混用。删除需要二次
 * 确认，对话框约束焦点并在关闭后把焦点还给触发的按钮。启停以控制平面的返回为准，失败时
 * 保留原状态并显示原因。
 * @module @chatdsh/client-automation/list
 */

import { Badge, Button, Dialog, EmptyState, ErrorNote, List, Panel, Row, Skeleton, StatusLine } from '@chatdsh/core-ui-kit';
import { useState } from 'react';
import { copyText, type CopyOutcome } from './copy.ts';
import {
  DELIVERY_STATE_LABELS,
  DELIVERY_STATE_TONES,
  describeCode,
  describeTarget,
  describeTrigger,
  formatTimestamp,
  webhookUrlOf,
} from './format.ts';
import type { Loadable } from './loadable.ts';
import type { AutomationGateway, AutomationRecord } from './types.ts';

/** 列表面板属性。 */
export interface AutomationListPanelProps {
  /** 数据入口。 */
  readonly gateway: AutomationGateway;
  /** 自动化列表。 */
  readonly automations: Loadable<readonly AutomationRecord[]>;
  /** 重新读取。 */
  readonly onReload: () => void;
  /** 新建入口。 */
  readonly onCreate: () => void;
  /** 编辑入口。 */
  readonly onEdit: (record: AutomationRecord) => void;
  /** 启停成功后的回调。 */
  readonly onChanged: (record: AutomationRecord) => void;
}

/** 页面来源，用于拼出完整的 webhook 地址。 */
function originOf(): string {
  return typeof location === 'undefined' ? 'http://127.0.0.1' : location.origin;
}

/**
 * 自动化列表面板。
 * @param props - 数据入口、列表与回调。
 * @returns 面板。
 */
export function AutomationListPanel({ gateway, automations, onReload, onCreate, onEdit, onChanged }: AutomationListPanelProps) {
  const [removing, setRemoving] = useState<AutomationRecord | undefined>(undefined);
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [copied, setCopied] = useState<{ readonly id: string; readonly outcome: CopyOutcome } | undefined>(undefined);

  if (automations.status === 'loading') return <Panel title="自动化列表"><Skeleton rows={3} /></Panel>;
  if (automations.status === 'failed') {
    return (
      <Panel title="自动化列表">
        <ErrorNote>
          自动化列表不可用：{automations.error instanceof Error ? automations.error.message : String(automations.error)}
        </ErrorNote>
        <Button id="chdsh-automation-reload" onClick={onReload}>重新读取</Button>
      </Panel>
    );
  }
  if (automations.value.length === 0) {
    return (
      <Panel title="自动化列表">
        <EmptyState action={<Button id="chdsh-automation-create-first" tone="primary" onClick={onCreate}>新建自动化</Button>}>
          还没有自动化。新建一条之后，外部系统可以通过 webhook 投递事件，原会话也可以按时间方式定时执行。
        </EmptyState>
      </Panel>
    );
  }

  const toggle = (record: AutomationRecord): void => {
    setBusy(record.id);
    setNotice(undefined);
    gateway.setEnabled(record.id, !record.enabled).then(
      (updated) => {
        setBusy(undefined);
        gateway.noteAction('automation-toggle', 'ok');
        onChanged(updated);
        setNotice(updated.enabled ? `已启用「${updated.name}」。` : `已停用「${updated.name}」，控制器不再受理新的投递。`);
      },
      (error: unknown) => {
        setBusy(undefined);
        gateway.noteAction('automation-toggle', 'failed');
        setNotice(`启停失败：${error instanceof Error ? error.message : String(error)}`);
      },
    );
  };

  return (
    <Panel
      title="自动化列表"
      count={`${String(automations.value.length)} 条`}
      subtitle="每行显示触发条件、执行目标与最近投递状态。启停只改变控制器是否受理投递，不会创建额外的定时调度。"
    >
      {notice === undefined ? null : <StatusLine>{notice}</StatusLine>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '8px' }}>
        <Button id="chdsh-automation-refresh" onClick={onReload}>重新读取列表</Button>
        <Button id="chdsh-automation-create" tone="primary" onClick={onCreate}>新建自动化</Button>
      </div>
      <List>
        {automations.value.map((record) => (
          <Row
            key={record.id}
            dot={record.enabled ? 'ok' : 'idle'}
            title={<span data-automation-id={record.id}>{record.name}</span>}
            badge={<Badge tone={record.enabled ? 'ok' : 'neutral'}>{record.enabled ? '已启用' : '已停用'}</Badge>}
            meta={(
              <>
                {`${describeTrigger(record.trigger, record.spec)} · ${describeTarget(record.target)}`}
                {record.lastDelivery === undefined
                  ? ' · 还没有投递记录'
                  : (
                    <>
                      {' · 最近投递 '}
                      <Badge tone={DELIVERY_STATE_TONES[record.lastDelivery.state]}>
                        {DELIVERY_STATE_LABELS[record.lastDelivery.state]}
                      </Badge>
                      {`（${formatTimestamp(record.lastDelivery.receivedAt)}）`}
                      {record.lastDelivery.code === undefined ? null : ` · ${describeCode(record.lastDelivery.code)}`}
                    </>
                  )}
              </>
            )}
            actions={(
              <>
                {record.trigger.kind === 'webhook' ? (
                  <Button
                    id={`chdsh-automation-copy-${record.id}`}
                    aria-label={`复制 webhook 地址：${record.name}`}
                    onClick={() => {
                      void copyText(webhookUrlOf(originOf(), record.id)).then((outcome) => {
                        setCopied({ id: record.id, outcome });
                        gateway.noteAction('automation-copy-webhook', outcome.ok ? 'ok' : 'failed');
                      });
                    }}
                  >
                    复制地址
                  </Button>
                ) : null}
                <Button
                  id={`chdsh-automation-edit-${record.id}`}
                  aria-label={`编辑自动化：${record.name}`}
                  onClick={() => onEdit(record)}
                >
                  编辑
                </Button>
                <Button
                  id={`chdsh-automation-toggle-${record.id}`}
                  aria-label={`${record.enabled ? '停用' : '启用'}自动化：${record.name}`}
                  disabled={busy === record.id}
                  onClick={() => toggle(record)}
                >
                  {busy === record.id ? '处理中…' : record.enabled ? '停用' : '启用'}
                </Button>
                <Button
                  id={`chdsh-automation-delete-${record.id}`}
                  tone="danger"
                  aria-label={`删除自动化：${record.name}`}
                  onClick={() => setRemoving(record)}
                >
                  删除
                </Button>
              </>
            )}
          />
        ))}
      </List>
      {copied === undefined ? null : (
        <div style={{ marginTop: '8px' }}>
          {copied.outcome.ok ? <StatusLine>webhook 地址已复制到剪贴板。</StatusLine> : (
            <>
              <StatusLine>{copied.outcome.detail}</StatusLine>
              <input
                readOnly
                aria-label="可手动选择的 webhook 地址"
                data-webhook-fallback
                value={webhookUrlOf(originOf(), copied.id)}
                onFocus={(event) => event.currentTarget.select()}
                style={{
                  boxSizing: 'border-box',
                  width: '100%',
                  minHeight: '44px',
                  padding: 'var(--cdh-s2)',
                  border: '1px solid var(--chatdsh-line-2)',
                  borderRadius: 'var(--cdh-r1)',
                  background: 'var(--chatdsh-panel)',
                  color: 'var(--chatdsh-ink)',
                  fontFamily: 'var(--cdh-font-mono)',
                  fontSize: 'var(--cdh-fs-12)',
                }}
              />
            </>
          )}
        </div>
      )}
      {removing === undefined ? null : (
        <DeleteConfirm
          gateway={gateway}
          record={removing}
          onClose={() => setRemoving(undefined)}
          onDone={(message) => {
            setRemoving(undefined);
            setNotice(message);
            onReload();
          }}
        />
      )}
    </Panel>
  );
}

/** 删除的二次确认。 */
function DeleteConfirm({ gateway, record, onClose, onDone }: {
  readonly gateway: AutomationGateway;
  readonly record: AutomationRecord;
  readonly onClose: () => void;
  readonly onDone: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);

  const confirm = (): void => {
    if (busy) return;
    setBusy(true);
    setFailure(undefined);
    gateway.remove(record.id).then(
      () => {
        setBusy(false);
        gateway.noteAction('automation-delete', 'ok');
        onDone(`已删除「${record.name}」。控制平面不再保留这条记录，已经建立的会话不受影响。`);
      },
      (error: unknown) => {
        setBusy(false);
        setFailure(error instanceof Error ? error.message : String(error));
        gateway.noteAction('automation-delete', 'failed');
      },
    );
  };

  return (
    <Dialog
      open
      title="删除自动化"
      description="删除之后外部投递不再命中这条记录，已经建立的会话保留。这条操作不能撤销。"
      onClose={onClose}
    >
      <p>{`${record.name} · ${describeTrigger(record.trigger)}`}</p>
      {failure === undefined ? null : <ErrorNote>{failure}</ErrorNote>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
        <Button id="chdsh-automation-delete-cancel" onClick={onClose}>取消</Button>
        <Button id="chdsh-automation-delete-confirm" tone="danger" disabled={busy} onClick={confirm}>
          {busy ? '正在删除…' : '确认删除'}
        </Button>
      </div>
    </Dialog>
  );
}
