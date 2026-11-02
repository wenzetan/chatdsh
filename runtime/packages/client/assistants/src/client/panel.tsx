/**
 * 助手面板：目录、内置档位、详情、向导与删除确认。
 *
 * 列表把助手记录与装配结果放在一起：名册诊断里装不起来的助手直接标出来，打开详情能看到真实
 * 装配行。内置档位是组合声明的预设，界面只列出装配结果，不提供编辑入口。
 *
 * 删除确认说明影响范围，删除结果报告仍引用该助手的进行中会话数：这些会话按创建时的定义继续
 * 运行，新的创建入口不再出现这个助手。
 * @module @chatdsh/client-assistants/panel
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorNote,
  List,
  Panel,
  Row,
  Skeleton,
  StatusLine,
} from '@chatdsh/core-ui-kit';

import { ASSISTANT_TIERS, TIER_LABEL, TIER_PRESET_ID } from '../index.ts';
import { AssistantDetail } from './detail.tsx';
import { AssistantForm } from './form.tsx';
import {
  describeFailure,
  formatTime,
  presetGroupOf,
  tierLabelOf,
  tierOf,
  toolCatalogOf,
} from './state.ts';
import { installAssistantsStyles } from './styles.ts';
import type { AssistantRecord, AssistantsGateway, AssistantsSnapshot } from './types.ts';

/** 面板的依赖。 */
export interface AssistantsPanelProps {
  /** 数据入口。 */
  readonly gateway: AssistantsGateway;
}

/** 对话框的展开状态。 */
type DialogState =
  | { readonly kind: 'none' }
  | { readonly kind: 'create' }
  | { readonly kind: 'edit'; readonly record: AssistantRecord }
  | { readonly kind: 'detail'; readonly record: AssistantRecord }
  | { readonly kind: 'delete'; readonly record: AssistantRecord };

/** 助手面板。 */
export function AssistantsPanel({ gateway }: AssistantsPanelProps) {
  const [snapshot, setSnapshot] = useState<AssistantsSnapshot | undefined>(undefined);
  const [loadFailure, setLoadFailure] = useState<unknown>(undefined);
  const [actionFailure, setActionFailure] = useState<unknown>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [reloadToken, setReloadToken] = useState(0);
  const [dialog, setDialog] = useState<DialogState>({ kind: 'none' });

  useEffect(() => {
    installAssistantsStyles(document);
  }, []);

  useEffect(() => {
    let active = true;
    setSnapshot(undefined);
    setLoadFailure(undefined);
    void gateway.load().then(
      (next) => {
        if (active) setSnapshot(next);
      },
      (error: unknown) => {
        if (active) setLoadFailure(error);
      },
    );
    return () => {
      active = false;
    };
  }, [gateway, reloadToken]);

  const reload = useCallback((): void => {
    setReloadToken((token) => token + 1);
  }, []);

  const close = (): void => setDialog({ kind: 'none' });

  const finish = (): void => {
    close();
    reload();
  };

  if (loadFailure !== undefined) {
    return (
      <Panel title="助手">
        <StatusLine tone="danger">{`助手列表读取失败：${describeFailure(loadFailure)}`}</StatusLine>
        <Button id="wp11-assistant-reload" onClick={reload}>重新加载</Button>
      </Panel>
    );
  }

  const catalog = toolCatalogOf(snapshot?.presets);
  const catalogFailure = snapshot?.failures.find((entry) => entry.source === 'presets')?.error;
  const skillsFailure = snapshot?.failures.find((entry) => entry.source === 'skills')?.error;

  return (
    <Panel
      title="助手"
      subtitle="助手是一个 preset 定义：档位决定工具面，附加工具行在档位之上追加。修改只影响后续创建的会话。"
      count={snapshot === undefined ? undefined : String(snapshot.assistants.length)}
    >
      {actionFailure === undefined ? null : <ErrorNote>{`上一次操作没有被受理：${describeFailure(actionFailure)}`}</ErrorNote>}
      {notice === undefined ? null : <StatusLine>{notice}</StatusLine>}
      {snapshot === undefined
        ? <Skeleton rows={3} />
        : (
          <>
            <Button id="wp11-assistant-create" tone="primary" onClick={() => setDialog({ kind: 'create' })}>新建助手</Button>
            <Button id="wp11-assistant-refresh" onClick={reload}>刷新</Button>
            {catalogFailure === undefined
              ? null
              : <StatusLine tone="danger">{`工具装配清单读取失败：${describeFailure(catalogFailure)}`}</StatusLine>}
            {skillsFailure === undefined
              ? null
              : <StatusLine tone="danger">{`技能目录读取失败：${describeFailure(skillsFailure)}，技能引用状态无法核对。`}</StatusLine>}
            {snapshot.assistants.length === 0
              ? (
                <EmptyState action={<Button id="wp11-assistant-create-empty" onClick={() => setDialog({ kind: 'create' })}>新建助手</Button>}>
                  还没有自定义助手。内置档位已经在用，自定义助手在档位之上追加指令与工具。
                </EmptyState>
              )
              : (
                <List>
                  {snapshot.assistants.map((record) => {
                    const group = presetGroupOf(snapshot.presets, record.id);
                    const rosterEntry = snapshot.roster?.find((entry) => entry.id === record.id);
                    const broken = rosterEntry?.broken ?? group?.broken;
                    return (
                      <Row
                        key={record.id}
                        dot={broken === undefined ? 'ok' : 'warn'}
                        title={record.name}
                        badge={(
                          <>
                            <Badge tone="brand">{TIER_LABEL[tierOf(record)]}</Badge>
                            {broken === undefined ? null : <Badge tone="warn">装配诊断</Badge>}
                          </>
                        )}
                        meta={(
                          <>
                            {`${record.description === '' ? '没有说明' : record.description} · 排序 ${String(record.order)} · 附加工具 ${String(record.tools.length)} 行 · 技能 ${String(record.skills.length)} 个`}
                            {broken === undefined ? '' : ` · 装配诊断：${broken}`}
                          </>
                        )}
                        actions={(
                          <>
                            <Button
                              aria-label={`详情 ${record.name}`}
                              onClick={() => {
                                gateway.noteAction('assistant.detail', 'ok');
                                setDialog({ kind: 'detail', record });
                              }}
                            >
                              详情
                            </Button>
                            <Button aria-label={`编辑 ${record.name}`} onClick={() => setDialog({ kind: 'edit', record })}>编辑</Button>
                            <Button aria-label={`删除 ${record.name}`} tone="danger" onClick={() => setDialog({ kind: 'delete', record })}>删除</Button>
                          </>
                        )}
                      />
                    );
                  })}
                </List>
              )}
            <section aria-label="内置档位" className="chdsh-assistants-group">
              <h4>{`内置档位（${String(ASSISTANT_TIERS.length)}）`}</h4>
              <StatusLine>内置档位由组合补丁层声明，界面只读：需要不同的工具面时新建助手，在档位上追加指令与工具。</StatusLine>
              <List>
                {ASSISTANT_TIERS.map((tier) => {
                  const group = presetGroupOf(snapshot.presets, TIER_PRESET_ID[tier]);
                  const rosterEntry = snapshot.roster?.find((entry) => entry.id === TIER_PRESET_ID[tier]);
                  return (
                    <Row
                      key={tier}
                      dot={group?.broken === undefined ? 'ok' : 'warn'}
                      title={TIER_LABEL[tier]}
                      badge={<Badge tone="neutral">内置只读</Badge>}
                      meta={`预设 ${TIER_PRESET_ID[tier]} · 装配行 ${String(group?.rows.length ?? 0)} 行${
                        group?.broken === undefined ? '' : ` · 装配诊断 ${group.broken}`
                      }${rosterEntry?.isDefault === true ? ' · 默认档位' : ''}`}
                    />
                  );
                })}
              </List>
            </section>
          </>
        )}
      {dialog.kind === 'create' || dialog.kind === 'edit'
        ? (
          <AssistantForm
            gateway={gateway}
            mode={dialog.kind}
            record={dialog.kind === 'edit' ? dialog.record : undefined}
            others={(snapshot?.assistants ?? []).filter((record) => dialog.kind === 'create' || record.id !== dialog.record.id)}
            skills={snapshot?.skills}
            skillsFailure={skillsFailure}
            catalog={catalog}
            catalogFailure={catalogFailure}
            onClose={close}
            onSaved={() => finish()}
          />
        )
        : null}
      {dialog.kind === 'detail'
        ? (
          <AssistantDetail
            record={dialog.record}
            presets={snapshot?.presets}
            roster={snapshot?.roster}
            skills={snapshot?.skills}
            onClose={close}
          />
        )
        : null}
      {dialog.kind === 'delete'
        ? (
          <DeleteConfirm
            gateway={gateway}
            record={dialog.record}
            onClose={close}
            onDone={(removal) => {
              setNotice(`已删除助手「${dialog.record.name}」；${String(removal.liveSessions)} 个进行中的会话继续使用创建时的定义。`);
              setActionFailure(undefined);
              finish();
            }}
            onFailed={(error) => {
              setActionFailure(error);
              reload();
            }}
          />
        )
        : null}
    </Panel>
  );
}

/** 删除的二次确认：列出定义、影响范围与进行中会话数。 */
function DeleteConfirm({ gateway, record, onClose, onDone, onFailed }: {
  readonly gateway: AssistantsGateway;
  readonly record: AssistantRecord;
  readonly onClose: () => void;
  readonly onDone: (removal: { readonly id: string; readonly removed: boolean; readonly liveSessions: number }) => void;
  readonly onFailed: (error: unknown) => void;
}) {
  const [failure, setFailure] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);

  const confirm = (): void => {
    if (busy) return;
    setBusy(true);
    setFailure(undefined);
    gateway.remove(record.id).then(
      (removal) => {
        setBusy(false);
        gateway.noteAction('assistant.delete', 'ok');
        onDone(removal);
      },
      (error: unknown) => {
        setBusy(false);
        setFailure(error);
        gateway.noteAction('assistant.delete', 'failed');
        onFailed(error);
      },
    );
  };

  return (
    <Dialog
      open
      title="删除助手"
      description="删除只移除配置与预设注册：进行中的会话按创建时的定义继续运行，新的创建入口不再出现这个助手。"
      onClose={onClose}
    >
      <p>{`${record.name}（${tierLabelOf(tierOf(record))} · 排序 ${String(record.order)}）`}</p>
      <StatusLine>
        {`附加工具 ${String(record.tools.length)} 行，技能引用 ${String(record.skills.length)} 条（${record.skills.length === 0 ? '没有引用' : record.skills.join('、')}）。`}
      </StatusLine>
      <StatusLine>{`最后修改于 ${formatTime(record.updatedAt)}。删除之后无法恢复，需要重新填写定义。`}</StatusLine>
      <StatusLine>宿主在删除时统计仍引用它的进行中会话数：这些会话按创建时的定义继续运行，删除结果里会显示这个数。</StatusLine>
      {failure === undefined ? null : <ErrorNote>{`删除没有被受理：${describeFailure(failure)}`}</ErrorNote>}
      <Button id="wp11-assistant-delete-cancel" onClick={onClose}>取消</Button>
      <Button id="wp11-assistant-delete-confirm" tone="danger" disabled={busy} onClick={confirm}>
        {busy ? '正在删除' : '删除助手'}
      </Button>
    </Dialog>
  );
}
