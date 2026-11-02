/**
 * 导入与分叉面板。
 *
 * 表单先预览导入内容：复制范围、事件与字符数、缺失附件与压缩损失；确认之后建立关联会话，并
 * 显示新会话的标识、工作目录、父会话与不重放说明。压缩复制会移出工具调用与工具结果，界面上
 * 必须勾选已经检查摘要与细节损失才允许创建。
 * @module @chatdsh/client-data-management/fork-panel
 */

import { Badge, Button, EmptyState, ErrorNote, Field, Panel, StatusLine } from '@chatdsh/core-ui-kit';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callFace, type DataManagementFace, type ForkRequest } from './face.ts';
import { IMPORT_MODE_LABELS, attachmentsText, compressionText, formatCount, formatTimestamp, scopeText } from './format.ts';
import { DataCallError, failureOf, failureText } from './errors.ts';
import { parseForkEstimate, parseForkOutcome, type ForkEstimateView, type ForkOutcomeView } from './schemas.ts';
import { browserTelemetry } from './telemetry.ts';

/** 表单的初始值。 */
const EMPTY_FORM = {
  sourceSessionId: '',
  sourceDeviceId: '',
  targetDeviceId: '',
  targetCwd: '',
  turnTo: '1',
  importMode: 'full-prefix' as 'full-prefix' | 'compressed',
};

/** 表单取值。 */
type ForkForm = typeof EMPTY_FORM;

/** 导入与分叉面板的属性。 */
export interface ForkPanelProps {
  /** 数据入口；缺省表示控制平面没有接入。 */
  readonly face?: DataManagementFace;
  /** 预估与结果变化时交给外部，供导出使用。 */
  readonly onLoaded?: (estimate: ForkEstimateView | undefined, outcome: ForkOutcomeView | undefined) => void;
}

/**
 * 导入与分叉面板。
 * @param props - 数据入口与回调。
 * @returns 面板内容。
 */
export function ForkPanel({ face, onLoaded }: ForkPanelProps) {
  const [form, setForm] = useState<ForkForm>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [estimate, setEstimate] = useState<ForkEstimateView | undefined>(undefined);
  const [outcome, setOutcome] = useState<ForkOutcomeView | undefined>(undefined);
  const [failure, setFailure] = useState<DataCallError | undefined>(undefined);
  const [createdFailure, setCreatedFailure] = useState<DataCallError | undefined>(undefined);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** 改表单时作废旧预估，避免用旧范围创建会话。 */
  const update = (patch: Partial<ForkForm>): void => {
    setForm((current) => ({ ...current, ...patch }));
    setEstimate(undefined);
    setOutcome(undefined);
    setAcknowledged(false);
    setFailure(undefined);
    setCreatedFailure(undefined);
  };

  const requestOf = (): ForkRequest | undefined => {
    if (form.sourceSessionId.trim() === '') {
      setFormError('请填写源会话标识');
      return undefined;
    }
    if (form.sourceDeviceId.trim() === '') {
      setFormError('请填写源设备标识');
      return undefined;
    }
    if (form.targetDeviceId.trim() === '') {
      setFormError('请填写目标设备');
      return undefined;
    }
    if (form.targetCwd.trim() === '') {
      setFormError('请填写目标目录');
      return undefined;
    }
    if (!/^\d+$/.test(form.turnTo) || Number.parseInt(form.turnTo, 10) < 1) {
      setFormError('结束回合必须是大于零的整数');
      return undefined;
    }
    setFormError(undefined);
    return {
      sourceSessionId: form.sourceSessionId.trim(),
      sourceDeviceId: form.sourceDeviceId.trim(),
      targetDeviceId: form.targetDeviceId.trim(),
      targetCwd: form.targetCwd.trim(),
      turnTo: Number.parseInt(form.turnTo, 10),
      importMode: form.importMode,
    };
  };

  const preview = useCallback(async (): Promise<void> => {
    const request = requestOf();
    if (request === undefined) return;
    if (face?.forkEstimate === undefined) {
      setFailure(failureOf(new Error('控制平面没有提供分叉预估接口')));
      return;
    }
    setBusy(true);
    setFailure(undefined);
    setCreatedFailure(undefined);
    setOutcome(undefined);
    try {
      const value = await callFace('预览导入内容', () => face.forkEstimate!(request), parseForkEstimate);
      if (!alive.current) return;
      setEstimate(value);
      browserTelemetry.action('data-fork-estimate', 'ok');
      onLoaded?.(value, undefined);
    } catch (error) {
      if (!alive.current) return;
      setEstimate(undefined);
      setFailure(failureOf(error));
      browserTelemetry.action('data-fork-estimate', 'failed');
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [face, form, onLoaded]);

  const create = async (): Promise<void> => {
    const request = requestOf();
    if (request === undefined || estimate === undefined) return;
    if (face?.fork === undefined) {
      setCreatedFailure(failureOf(new Error('控制平面没有提供分叉接口')));
      return;
    }
    setBusy(true);
    setCreatedFailure(undefined);
    try {
      const value = await callFace('创建关联会话', () => face.fork!(request), parseForkOutcome);
      if (!alive.current) return;
      setOutcome(value);
      browserTelemetry.action('data-fork-create', 'ok');
      onLoaded?.(estimate, value);
    } catch (error) {
      if (!alive.current) return;
      setCreatedFailure(failureOf(error));
      browserTelemetry.action('data-fork-create', 'failed');
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const lossyBlocked = estimate !== undefined && estimate.compressionLoss && !acknowledged;

  return (
    <Panel title="导入与分叉" subtitle="从控制平面的副本复制完整回合前缀到本机，旧工具调用与定时任务不在新设备重放。">
      <Field label="源会话标识" required error={formError}>
        <input type="text" data-fork-source value={form.sourceSessionId} onChange={(event) => { update({ sourceSessionId: event.target.value }); }} />
      </Field>
      <Field label="源设备标识" required help="源会话所属的执行设备；副本由控制平面保存。">
        <input type="text" data-fork-source-device value={form.sourceDeviceId} onChange={(event) => { update({ sourceDeviceId: event.target.value }); }} />
      </Field>
      <Field label="目标设备" required help="新会话的执行设备，必须是已登记且在线的本机运行时。">
        <input type="text" data-fork-target-device value={form.targetDeviceId} onChange={(event) => { update({ targetDeviceId: event.target.value }); }} />
      </Field>
      <Field label="目标目录" required help="新会话的工作目录绝对路径。">
        <input type="text" data-fork-target-cwd value={form.targetCwd} onChange={(event) => { update({ targetCwd: event.target.value }); }} />
      </Field>
      <Field label="结束回合" required help="复制从第 1 回合到这一回合的完整前缀。">
        <input type="number" min={1} step={1} data-fork-turn value={form.turnTo} onChange={(event) => { update({ turnTo: event.target.value }); }} />
      </Field>
      <Field label="复制方式" required>
        <select
          data-fork-mode
          value={form.importMode}
          onChange={(event) => {
            update({ importMode: event.target.value === 'compressed' ? 'compressed' : 'full-prefix' });
          }}
        >
          <option value="full-prefix">{IMPORT_MODE_LABELS['full-prefix']}</option>
          <option value="compressed">{IMPORT_MODE_LABELS.compressed}</option>
        </select>
      </Field>
      <Button data-fork-estimate disabled={busy} onClick={() => { void preview(); }}>
        {busy ? '正在预览…' : '预览导入内容'}
      </Button>
      {failure === undefined ? null : <ErrorNote>{`预览导入内容失败：${failureText(failure)}`}</ErrorNote>}
      {estimate === undefined ? <EmptyState>还没有预览导入内容。</EmptyState> : (
        <div data-fork-estimate-view>
          <dl data-fork-scope>
            <div><dt>导入范围</dt><dd data-fork-scope-turns>{scopeText(estimate.scope)}</dd></div>
            <div><dt>复制方式</dt><dd data-fork-mode-label>{IMPORT_MODE_LABELS[estimate.importMode]}</dd></div>
            <div><dt>压缩标记</dt><dd>{compressionText(estimate.scope)}</dd></div>
            <div><dt>附件完整性</dt><dd>{attachmentsText(estimate.scope)}</dd></div>
            <div>
              <dt>缺失附件</dt>
              <dd data-fork-missing-attachments>
                {estimate.missingAttachmentIds.length === 0
                  ? '没有缺失的附件'
                  : estimate.missingAttachmentIds.join('、')}
              </dd>
            </div>
            <div>
              <dt>预计损失</dt>
              <dd data-fork-loss>
                {estimate.compressionLoss
                  ? '压缩复制会移出工具调用与工具结果，工具输出原文不再保留'
                  : '按完整前缀复制，没有内容被替换'}
              </dd>
            </div>
          </dl>
          {estimate.compressionLoss
            ? (
              <label data-fork-acknowledge>
                <input
                  type="checkbox"
                  data-fork-acknowledge-check
                  checked={acknowledged}
                  onChange={(event) => {
                    setAcknowledged(event.target.checked);
                  }}
                />
                已经检查摘要内容，了解压缩复制会丢失工具输出原文
              </label>
            )
            : null}
          <Button data-fork-create tone="primary" disabled={busy || lossyBlocked} onClick={() => { void create(); }}>
            {busy ? '正在创建…' : '确认创建关联会话'}
          </Button>
          {lossyBlocked ? <StatusLine tone="danger">压缩复制的损失还没有确认，不能创建会话。</StatusLine> : null}
        </div>
      )}
      {createdFailure === undefined ? null : <ErrorNote>{`创建关联会话失败：${failureText(createdFailure)}`}</ErrorNote>}
      {outcome === undefined ? null : (
        <div data-fork-outcome>
          <h3>分叉结果</h3>
          <dl>
            <div><dt>新会话</dt><dd data-fork-new-session>{outcome.sessionId}</dd></div>
            <div><dt>父会话</dt><dd data-fork-parent>{outcome.parentSession}</dd></div>
            <div><dt>工作目录</dt><dd>{outcome.cwd}</dd></div>
            <div><dt>建立时刻</dt><dd>{formatTimestamp(outcome.createdAt)}</dd></div>
          </dl>
          <h3>不重放说明</h3>
          <ul data-fork-replay>
            <li>
              <Badge tone="ok">{`工具调用重放 ${formatCount(outcome.replay.replayedToolCalls, '个')}`}</Badge>
              工具调用记录保留为阅读资料，不在新设备重新执行。
            </li>
            <li>
              <Badge tone="ok">{`定时任务重放 ${formatCount(outcome.replay.replayedScheduledTasks, '个')}`}</Badge>
              {`定时任务仍然留在源会话上，共 ${formatCount(outcome.replay.retainedScheduledTasks, '个')}。`}
            </li>
            <li>
              {`压缩复制移出工具调用 ${formatCount(outcome.replay.droppedToolCalls, '个')}、工具结果 ${formatCount(outcome.replay.droppedToolResults, '个')}。`}
            </li>
            <li>
              {`源会话继续在自己的设备上执行，执行归属不变。`}
            </li>
          </ul>
        </div>
      )}
    </Panel>
  );
}
