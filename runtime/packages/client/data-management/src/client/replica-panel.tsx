/**
 * 只读副本面板。
 *
 * 显示一条会话的副本状态、读取来源、可读范围与失效说明：完整可读时给出回合、事件与字符数；
 * 部分可读时列出缺失的附件数量；不可读取时说明副本缺失的原因与恢复正常阅读的条件。状态与
 * 范围都来自控制平面的真实读数，读不到时显示失败原因。
 * @module @chatdsh/client-data-management/replica-panel
 */

import { Badge, Button, EmptyState, ErrorNote, Field, Panel } from '@chatdsh/core-ui-kit';
import { useCallback, useRef, useState } from 'react';
import { callFace, type DataManagementFace } from './face.ts';
import {
  READ_ONLY_REASON_LABELS,
  READ_SOURCE_LABELS,
  REPLICA_STATE_LABELS,
  attachmentsText,
  compressionText,
  formatCount,
  formatTimestamp,
  scopeText,
} from './format.ts';
import { failureOf, failureText, type DataCallError } from './errors.ts';
import { parseReplicaState, type ReplicaState } from './schemas.ts';
import { browserTelemetry } from './telemetry.ts';

/** 状态对应的徽标色调。 */
const STATE_TONES = { complete: 'ok', partial: 'warn', missing: 'danger' } as const;

/** 只读副本面板的属性。 */
export interface ReplicaPanelProps {
  /** 数据入口；缺省表示控制平面没有接入。 */
  readonly face?: DataManagementFace;
  /** 读取成功时把状态交给外部，供导出使用。 */
  readonly onLoaded?: (state: ReplicaState) => void;
}

/**
 * 只读副本面板。
 * @param props - 数据入口与回调。
 * @returns 面板内容。
 */
export function ReplicaPanel({ face, onLoaded }: ReplicaPanelProps) {
  const [sessionId, setSessionId] = useState('');
  const [inputError, setInputError] = useState<string | undefined>(undefined);
  const [state, setState] = useState<ReplicaState | undefined>(undefined);
  const [failure, setFailure] = useState<DataCallError | undefined>(undefined);
  const [reading, setReading] = useState(false);
  const alive = useRef(true);

  const read = useCallback(async (): Promise<void> => {
    if (sessionId.trim() === '') {
      setInputError('请填写会话标识');
      return;
    }
    if (face?.replica === undefined) {
      setFailure(failureOf(new Error('控制平面没有提供只读副本接口')));
      return;
    }
    setInputError(undefined);
    setFailure(undefined);
    setReading(true);
    try {
      const value = await callFace('读取只读副本', () => face.replica!(sessionId.trim()), parseReplicaState);
      if (!alive.current) return;
      setState(value);
      browserTelemetry.action('data-replica-read', 'ok');
      onLoaded?.(value);
    } catch (error) {
      if (!alive.current) return;
      setState(undefined);
      setFailure(failureOf(error));
      browserTelemetry.action('data-replica-read', 'failed');
    } finally {
      if (alive.current) setReading(false);
    }
  }, [face, sessionId, onLoaded]);

  return (
    <Panel title="只读副本" subtitle="副本用于离线阅读、跨设备导入与设备故障恢复。这里显示状态、来源与可读范围。">
      <Field label="会话标识" error={inputError} help="填写控制平面里的会话标识，读取它的副本状态。">
        <input
          type="text"
          data-replica-input
          value={sessionId}
          onChange={(event) => {
            setSessionId(event.target.value);
          }}
        />
      </Field>
      <Button data-replica-read disabled={reading} onClick={() => { void read(); }}>
        {reading ? '正在读取…' : '读取副本状态'}
      </Button>
      {failure === undefined ? null : <ErrorNote>{`读取副本状态失败：${failureText(failure)}`}</ErrorNote>}
      {state === undefined && failure === undefined
        ? <EmptyState>还没有读取任何会话的副本状态。</EmptyState>
        : null}
      {state === undefined ? null : (
        <div data-replica-view>
          <dl>
            <div>
              <dt>状态</dt>
              <dd data-replica-state={state.replica.state}>
                <Badge tone={STATE_TONES[state.replica.state]}>{REPLICA_STATE_LABELS[state.replica.state]}</Badge>
              </dd>
            </div>
            <div><dt>读取来源</dt><dd data-replica-source>{READ_SOURCE_LABELS[state.source]}</dd></div>
            <div>
              <dt>只读原因</dt>
              <dd data-replica-readonly>{state.readOnlyReason === undefined ? '可以写入' : READ_ONLY_REASON_LABELS[state.readOnlyReason]}</dd>
            </div>
            <div>
              <dt>读取时刻</dt>
              <dd data-replica-read-at>{state.replica.readAt === undefined ? '没有读取到内容' : formatTimestamp(state.replica.readAt)}</dd>
            </div>
            <div><dt>缺失附件</dt><dd data-replica-missing-attachments>{formatCount(state.missingAttachments, '个')}</dd></div>
            <div><dt>保留周期</dt><dd>{`${String(state.retentionDays)} 天`}</dd></div>
          </dl>
          {state.replica.scope === undefined
            ? null
            : (
              <div data-replica-scope>
                <h3>可读范围</h3>
                <p data-replica-scope-turns>{scopeText(state.replica.scope)}</p>
                <p data-replica-scope-compression>{compressionText(state.replica.scope)}</p>
                <p data-replica-scope-attachments>{attachmentsText(state.replica.scope)}</p>
              </div>
            )}
          <h3>失效说明</h3>
          <p data-replica-invalidation>
            {state.replica.state === 'missing'
              ? `控制平面没有这段会话的副本：超过 ${String(state.retentionDays)} 天保留期的副本会被清理，源设备离线期间无法用副本还原内容。设备重新在线后可以读取权威日志。`
              : state.replica.state === 'partial'
                ? `只读到部分内容：${formatCount(state.missingAttachments, '个附件')}不在控制平面，需要源设备在线才能读取附件原文。`
                : '当前可以离线阅读这段会话的文本内容；发送、审批与终端仍然需要源设备在线。'}
          </p>
        </div>
      )}
    </Panel>
  );
}
