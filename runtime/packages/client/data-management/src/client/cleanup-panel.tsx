/**
 * 副本清理面板。
 *
 * 先读写保留期，再按保留期计算影响范围：对象、范围、可释放空间与逐项依赖。依赖没有逐项勾选
 * 时执行按钮保持不可用；执行后显示预计释放与实际释放、删除的会话与事件条数，并重新计算范围、
 * 通知外部重新清点用量。设备权威日志与工作区文件不在清理范围内，结果里明确写出它们保留。
 * @module @chatdsh/client-data-management/cleanup-panel
 */

import { RETENTION_DAYS_RANGE } from '@chatdsh/core-contracts';
import { Badge, Button, EmptyState, ErrorNote, Field, Panel, Skeleton, StatusLine } from '@chatdsh/core-ui-kit';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callFace, type DataManagementFace } from './face.ts';
import { formatBytes, formatCount, formatTimestamp } from './format.ts';
import { DataCallError, failureOf, failureText, type Loadable } from './errors.ts';
import {
  parseCleanupEstimate,
  parseCleanupOutcome,
  parseRetentionPolicy,
  type CleanupCandidate,
  type CleanupEstimateView,
  type CleanupOutcome,
  type RetentionPolicy,
} from './schemas.ts';
import { browserTelemetry } from './telemetry.ts';

/** 依赖确认的键：一个对象对应一项。 */
function dependencyKeyOf(candidate: CleanupCandidate): string {
  return candidate.sessionId;
}

/** 一个对象是否带依赖。 */
function hasDependency(candidate: CleanupCandidate): boolean {
  return candidate.dependentShares > 0 || candidate.activeImports > 0;
}

/** 依赖的可读说明。 */
function dependencyText(candidate: CleanupCandidate): string {
  const parts: string[] = [];
  if (candidate.dependentShares > 0) parts.push(`${String(candidate.dependentShares)} 个有效分享`);
  if (candidate.activeImports > 0) parts.push(`${String(candidate.activeImports)} 个活动导入`);
  return parts.join('，');
}

/** 清理面板的属性。 */
export interface CleanupPanelProps {
  /** 数据入口；缺省表示控制平面没有接入。 */
  readonly face?: DataManagementFace;
  /** 保留期变化或清理执行成功后的回调，供外部重新读取用量与保留策略。 */
  readonly onChanged?: () => void;
  /** 预估或执行结果变化时交给外部，供导出使用。 */
  readonly onLoaded?: (estimate: CleanupEstimateView, outcome?: CleanupOutcome) => void;
}

/**
 * 副本清理面板。
 * @param props - 数据入口与回调。
 * @returns 面板内容。
 */
export function CleanupPanel({ face, onChanged, onLoaded }: CleanupPanelProps) {
  const [retention, setRetention] = useState<Loadable<RetentionPolicy>>({ status: 'loading' });
  const [days, setDays] = useState('');
  const [daysError, setDaysError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [estimate, setEstimate] = useState<CleanupEstimateView | undefined>(undefined);
  const [estimating, setEstimating] = useState(false);
  const [estimateFailure, setEstimateFailure] = useState<DataCallError | undefined>(undefined);
  const [checked, setChecked] = useState<readonly string[]>([]);
  const [executing, setExecuting] = useState(false);
  const [outcome, setOutcome] = useState<CleanupOutcome | undefined>(undefined);
  const [outcomeFailure, setOutcomeFailure] = useState<DataCallError | undefined>(undefined);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const loadRetention = useCallback(async (): Promise<void> => {
    if (face?.retention === undefined) {
      if (alive.current) setRetention({ status: 'unavailable' });
      return;
    }
    try {
      const policy = await callFace('读取保留策略', () => face.retention!(), parseRetentionPolicy);
      if (!alive.current) return;
      setRetention({ status: 'ready', value: policy });
      setDays(String(policy.days));
    } catch (error) {
      if (alive.current) setRetention({ status: 'failed', failure: failureOf(error) });
    }
  }, [face]);

  useEffect(() => {
    void loadRetention();
  }, [loadRetention]);

  const save = async (): Promise<void> => {
    const parsed = /^\d+$/.test(days) ? Number.parseInt(days, 10) : Number.NaN;
    if (!Number.isInteger(parsed) || parsed < RETENTION_DAYS_RANGE.min || parsed > RETENTION_DAYS_RANGE.max) {
      setDaysError(`保留期必须是 ${String(RETENTION_DAYS_RANGE.min)} 到 ${String(RETENTION_DAYS_RANGE.max)} 之间的整数天`);
      return;
    }
    setDaysError(undefined);
    if (face?.saveRetention === undefined) {
      setRetention({ status: 'unavailable' });
      return;
    }
    setSaving(true);
    try {
      const policy = await callFace('保存保留策略', () => face.saveRetention!(parsed), parseRetentionPolicy);
      if (!alive.current) return;
      setRetention({ status: 'ready', value: policy });
      setDays(String(policy.days));
      setEstimate(undefined);
      setOutcome(undefined);
      setChecked([]);
      browserTelemetry.action('data-retention-save', 'ok');
      onChanged?.();
    } catch (error) {
      if (!alive.current) return;
      setRetention({ status: 'failed', failure: failureOf(error) });
      browserTelemetry.action('data-retention-save', 'failed');
    } finally {
      if (alive.current) setSaving(false);
    }
  };

  const computeEstimate = useCallback(async (reset = true): Promise<CleanupEstimateView | undefined> => {
    if (face?.cleanupEstimate === undefined) return undefined;
    setEstimating(true);
    setEstimateFailure(undefined);
    if (reset) setOutcome(undefined);
    setChecked([]);
    try {
      const value = await callFace(
        '计算清理影响范围',
        () => face.cleanupEstimate!({ retentionDays: retention.status === 'ready' ? retention.value.days : undefined }),
        parseCleanupEstimate,
      );
      if (!alive.current) return undefined;
      setEstimate(value);
      browserTelemetry.action('data-cleanup-estimate', 'ok');
      onLoaded?.(value);
      return value;
    } catch (error) {
      if (!alive.current) return undefined;
      setEstimateFailure(failureOf(error));
      browserTelemetry.action('data-cleanup-estimate', 'failed');
      return undefined;
    } finally {
      if (alive.current) setEstimating(false);
    }
  }, [face, retention, onLoaded]);

  const execute = async (): Promise<void> => {
    if (estimate === undefined) return;
    if (face?.cleanupExecute === undefined) return;
    const dependencies = estimate.candidates.filter(hasDependency);
    const confirmed = dependencies.every((candidate) => checked.includes(dependencyKeyOf(candidate)));
    setExecuting(true);
    setOutcomeFailure(undefined);
    try {
      const value = await callFace(
        '执行副本清理',
        () => face.cleanupExecute!({ estimateId: estimate.estimateId, confirmDependencies: confirmed }),
        parseCleanupOutcome,
      );
      if (!alive.current) return;
      setOutcome(value);
      browserTelemetry.action('data-cleanup-execute', 'ok');
      onLoaded?.(estimate, value);
      onChanged?.();
      const refreshed = await computeEstimate(false);
      if (refreshed !== undefined && alive.current) onLoaded?.(refreshed, value);
    } catch (error) {
      if (!alive.current) return;
      setOutcomeFailure(failureOf(error));
      browserTelemetry.action('data-cleanup-execute', 'failed');
    } finally {
      if (alive.current) setExecuting(false);
    }
  };

  const dependencies = estimate === undefined ? [] : estimate.candidates.filter(hasDependency);
  const allChecked = dependencies.every((candidate) => checked.includes(dependencyKeyOf(candidate)));

  return (
    <Panel title="副本清理" subtitle="只删除控制平面的副本。设备权威日志与工作区文件不在清理范围内。">
      <h3>保留周期</h3>
      {retention.status === 'loading' ? <Skeleton rows={1} /> : null}
      {retention.status === 'unavailable'
        ? <EmptyState>控制平面没有提供保留策略接口，这里不能修改保留周期。</EmptyState>
        : null}
      {retention.status === 'failed'
        ? <ErrorNote>{`读取保留策略失败：${failureText(retention.failure)}`}</ErrorNote>
        : null}
      {retention.status === 'ready'
        ? (
          <div data-retention-editor>
            <Field label="副本保留周期（天）" error={daysError} help={`允许 ${String(RETENTION_DAYS_RANGE.min)} 到 ${String(RETENTION_DAYS_RANGE.max)} 天，缺省 ${String(RETENTION_DAYS_RANGE.default)} 天。`}>
              <input
                type="number"
                min={RETENTION_DAYS_RANGE.min}
                max={RETENTION_DAYS_RANGE.max}
                step={1}
                data-retention-input
                value={days}
                onChange={(event) => {
                  setDays(event.target.value);
                }}
              />
            </Field>
            <StatusLine>
              {retention.value.defaulted
                ? `当前使用缺省保留期 ${String(retention.value.days)} 天。`
                : `当前保留期 ${String(retention.value.days)} 天${retention.value.updatedAt === undefined ? '' : `，最近写入于 ${formatTimestamp(retention.value.updatedAt)}`}。`}
            </StatusLine>
            <Button data-retention-save disabled={saving} onClick={() => { void save(); }}>
              {saving ? '正在保存…' : '保存保留周期'}
            </Button>
          </div>
        )
        : null}

      <h3>影响范围</h3>
      <Button data-cleanup-estimate disabled={estimating || retention.status !== 'ready'} onClick={() => { void computeEstimate(); }}>
        {estimating ? '正在计算…' : '计算影响范围'}
      </Button>
      {estimateFailure === undefined
        ? null
        : (
          <div data-cleanup-estimate-failure>
            <ErrorNote>{`计算影响范围失败：${failureText(estimateFailure)}`}</ErrorNote>
          </div>
        )}
      {estimate === undefined
        ? <StatusLine>还没有计算影响范围。</StatusLine>
        : (
          <div data-cleanup-estimate-view>
            <dl data-cleanup-estimate>
              <div><dt>涉及对象</dt><dd data-cleanup-objects>{formatCount(estimate.objectCount, '个会话副本')}</dd></div>
              <div><dt>可释放空间</dt><dd data-cleanup-reclaimable data-bytes={estimate.reclaimableBytes}>{formatBytes(estimate.reclaimableBytes)}</dd></div>
              <div><dt>保留周期</dt><dd>{`${String(estimate.retentionDays)} 天`}</dd></div>
              <div><dt>预估时刻</dt><dd>{formatTimestamp(estimate.estimatedAt)}</dd></div>
              <div><dt>有效分享依赖</dt><dd data-cleanup-shares>{formatCount(estimate.dependentShares, '个')}</dd></div>
              <div><dt>活动导入依赖</dt><dd data-cleanup-imports>{formatCount(estimate.activeImports, '个')}</dd></div>
            </dl>
            {estimate.candidates.length === 0
              ? <EmptyState>这个保留期下没有到期的副本。</EmptyState>
              : (
                <table data-cleanup-candidates>
                  <caption>范围内逐项对象</caption>
                  <thead>
                    <tr>
                      <th scope="col">会话</th>
                      <th scope="col">设备</th>
                      <th scope="col">工作区</th>
                      <th scope="col">副本字节</th>
                      <th scope="col">事件数</th>
                      <th scope="col">最近事件</th>
                      <th scope="col">到期时刻</th>
                      <th scope="col">依赖</th>
                    </tr>
                  </thead>
                  <tbody>
                    {estimate.candidates.map((candidate) => (
                      <tr key={candidate.sessionId} data-cleanup-candidate={candidate.sessionId}>
                        <th scope="row">{candidate.sessionId}</th>
                        <td>{candidate.deviceId === '' ? '没有归属设备' : candidate.deviceId}</td>
                        <td>{candidate.workspaceId ?? '聊天会话'}</td>
                        <td>{formatBytes(candidate.replicaBytes)}</td>
                        <td>{formatCount(candidate.eventCount, '个')}</td>
                        <td>{formatTimestamp(candidate.lastEventAt)}</td>
                        <td>{formatTimestamp(candidate.expiresAt)}</td>
                        <td>{hasDependency(candidate) ? <Badge tone="warn">{dependencyText(candidate)}</Badge> : '没有依赖'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            {dependencies.length === 0
              ? null
              : (
                <fieldset data-cleanup-dependencies>
                  <legend>依赖影响逐项确认</legend>
                  {dependencies.map((candidate) => (
                    <label key={dependencyKeyOf(candidate)}>
                      <input
                        type="checkbox"
                        data-cleanup-dependency={candidate.sessionId}
                        checked={checked.includes(dependencyKeyOf(candidate))}
                        onChange={(event) => {
                          const key = dependencyKeyOf(candidate);
                          setChecked((current) => event.target.checked
                            ? [...current, key]
                            : current.filter((value) => value !== key));
                        }}
                      />
                      {`清理 ${candidate.sessionId} 之后：${dependencyText(candidate)}失效或无法继续`}
                    </label>
                  ))}
                </fieldset>
              )}
            <StatusLine>
              {dependencies.length === 0 || allChecked
                ? '范围与依赖影响已经确认。'
                : '依赖没有逐项确认前不能执行清理。'}
            </StatusLine>
            <Button
              data-cleanup-execute
              tone="danger"
              disabled={executing || !(dependencies.length === 0 || allChecked)}
              onClick={() => { void execute(); }}
            >
              {executing ? '正在执行…' : '清理副本'}
            </Button>
          </div>
        )}
      {outcomeFailure === undefined
        ? null
        : (
          <div data-cleanup-failure>
            <ErrorNote>{`执行清理失败：${failureText(outcomeFailure)}`}</ErrorNote>
          </div>
        )}
      {outcome === undefined ? null : (
        <div data-cleanup-outcome>
          <h3>执行结果</h3>
          <dl>
            <div><dt>预计释放</dt><dd>{formatBytes(outcome.estimatedBytes)}</dd></div>
            <div><dt>实际释放</dt><dd data-cleanup-reclaimed data-bytes={outcome.reclaimedBytes}>{formatBytes(outcome.reclaimedBytes)}</dd></div>
            <div><dt>删除的会话副本</dt><dd data-cleanup-removed-sessions>{formatCount(outcome.removedSessions, '个')}</dd></div>
            <div><dt>删除的事件行</dt><dd>{formatCount(outcome.removedEvents, '个')}</dd></div>
            <div><dt>依赖结果</dt><dd>{`有效分享 ${String(outcome.dependencies.shares)} 个，活动导入 ${String(outcome.dependencies.imports)} 个`}</dd></div>
          </dl>
          <StatusLine>{outcome.authoritativeLogsPreserved ? '设备权威日志与工作区文件保留。' : '权威日志状态未知。'}</StatusLine>
          <StatusLine>实际释放量取数据库文件在清理前后的真实字节差，空闲页与日志文件一并回收，因此可能大于预估。</StatusLine>
        </div>
      )}
    </Panel>
  );
}
