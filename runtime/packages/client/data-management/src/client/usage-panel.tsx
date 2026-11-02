/**
 * 用量与空间面板。
 *
 * 显示一次真实清点的结果：数据根、文件数、总占用、保留策略与五个来源分类，再按设备、工作区
 * 与会话三个维度列出会话数量、文本副本字节与附件空间。读取失败时只显示失败原因与重试入口，
 * 不显示任何看起来正常的零值。
 * @module @chatdsh/client-data-management/usage-panel
 */

import { Button, EmptyState, ErrorNote, Panel, Skeleton, StatusLine } from '@chatdsh/core-ui-kit';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callFace, type DataManagementFace } from './face.ts';
import { BUCKET_LABELS, DIMENSION_LABELS, formatBytes, formatCount, formatShare, formatTimestamp } from './format.ts';
import { failureOf, failureText, type Loadable } from './errors.ts';
import { parseRetentionPolicy, parseUsageReport, type RetentionPolicy, type UsageReport } from './schemas.ts';
import { browserTelemetry } from './telemetry.ts';

/** 五个来源分类的显示顺序。 */
const BUCKETS = ['session', 'replica', 'attachment', 'memory', 'other'] as const;

/** 三个维度的显示顺序。 */
const DIMENSIONS = ['device', 'workspace', 'session'] as const;

/** 用量面板的属性。 */
export interface UsagePanelProps {
  /** 数据入口；缺省表示控制平面没有接入。 */
  readonly face?: DataManagementFace;
  /** 变化时重新读取一次；清理执行后由外部递增。 */
  readonly refreshToken?: number;
  /** 读取成功时把读数交给外部，供导出使用。 */
  readonly onLoaded?: (usage: UsageReport, retention: RetentionPolicy) => void;
}

/**
 * 用量与空间面板。
 * @param props - 数据入口与刷新信号。
 * @returns 面板内容。
 */
export function UsagePanel({ face, refreshToken = 0, onLoaded }: UsagePanelProps) {
  const [usage, setUsage] = useState<Loadable<UsageReport>>({ status: 'loading' });
  const [retention, setRetention] = useState<Loadable<RetentionPolicy>>({ status: 'loading' });
  const [dimension, setDimension] = useState<(typeof DIMENSIONS)[number]>('device');
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async (): Promise<void> => {
    if (face?.usage === undefined) {
      if (alive.current) setUsage({ status: 'unavailable' });
      return;
    }
    if (alive.current) setUsage({ status: 'loading' });
    try {
      const value = await callFace('读取用量', () => face.usage!(), parseUsageReport);
      if (!alive.current) return;
      setUsage({ status: 'ready', value });
      browserTelemetry.action('data-usage-read', 'ok');
      let policy: RetentionPolicy | undefined;
      if (face.retention !== undefined) {
        policy = await callFace('读取保留策略', () => face.retention!(), parseRetentionPolicy);
        if (alive.current) setRetention({ status: 'ready', value: policy });
      } else if (alive.current) {
        setRetention({ status: 'unavailable' });
      }
      if (policy !== undefined && alive.current) onLoaded?.(value, policy);
    } catch (error) {
      if (!alive.current) return;
      setUsage({ status: 'failed', failure: failureOf(error) });
      browserTelemetry.action('data-usage-read', 'failed');
    }
  }, [face, onLoaded]);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  const count = usage.status === 'ready' ? formatBytes(usage.value.totalBytes) : undefined;

  return (
    <Panel title="用量与空间" subtitle="按真实字节统计设备、工作区与会话的占用，分类明细来自同一台设备的数据根。" count={count}>
      {usage.status === 'loading' ? <Skeleton rows={4} /> : null}
      {usage.status === 'unavailable' ? <EmptyState>控制平面没有提供用量接口，这里不显示任何读数。</EmptyState> : null}
      {usage.status === 'failed'
        ? (
          <div data-usage-failed>
            <ErrorNote>{`读取用量失败：${failureText(usage.failure)}`}</ErrorNote>
            <StatusLine tone="danger">读不到读数时不显示任何数字，请稍后重新清点。</StatusLine>
            <Button onClick={() => { void load(); }}>重新清点</Button>
          </div>
        )
        : null}
      {usage.status === 'ready'
        ? (
          <div data-usage-ready>
            <dl data-usage-facts>
              <div><dt>清点时刻</dt><dd data-usage-measured-at>{formatTimestamp(usage.value.measuredAt)}</dd></div>
              <div><dt>数据根</dt><dd data-usage-root>{usage.value.root}</dd></div>
              <div><dt>文件数</dt><dd data-usage-files>{formatCount(usage.value.fileCount, '个文件')}</dd></div>
              <div><dt>总占用</dt><dd data-usage-total data-bytes={usage.value.totalBytes}>{formatBytes(usage.value.totalBytes)}</dd></div>
              <div>
                <dt>保留周期</dt>
                <dd data-usage-retention>
                  {retention.status === 'ready'
                    ? `${String(retention.value.days)} 天${retention.value.defaulted ? '（缺省值）' : ''}`
                    : '未读取到保留策略'}
                </dd>
              </div>
              <div>
                <dt>副本来源</dt>
                <dd data-usage-replica-source>
                  {usage.value.replicaSource === 'measured'
                    ? '控制平面副本已计入统计'
                    : '控制平面没有副本读数，副本字节按缺省处理'}
                </dd>
              </div>
            </dl>

            <h3>分类明细</h3>
            <table data-usage-buckets>
              <caption>按文件所在目录分类的真实字节</caption>
              <thead>
                <tr><th scope="col">分类</th><th scope="col">占用</th><th scope="col">文件数</th><th scope="col">占比</th></tr>
              </thead>
              <tbody>
                {BUCKETS.map((bucket) => (
                  <tr key={bucket} data-bucket={bucket}>
                    <th scope="row">{BUCKET_LABELS[bucket]}</th>
                    <td data-bucket-bytes data-bytes={usage.value.buckets[bucket].bytes}>{formatBytes(usage.value.buckets[bucket].bytes)}</td>
                    <td>{formatCount(usage.value.buckets[bucket].files, '个文件')}</td>
                    <td>{formatShare(usage.value.buckets[bucket].bytes, usage.value.totalBytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h3>控制平面副本</h3>
            <dl data-usage-replica>
              <div><dt>有副本的会话</dt><dd>{formatCount(usage.value.replica.sessions, '个会话')}</dd></div>
              <div><dt>副本载荷</dt><dd>{formatBytes(usage.value.replica.payloadBytes)}</dd></div>
              <div><dt>副本表占用</dt><dd>{formatBytes(usage.value.replica.tableBytes)}</dd></div>
              <div><dt>数据库文件</dt><dd>{formatBytes(usage.value.replica.databaseBytes)}</dd></div>
            </dl>

            <h3>维度明细</h3>
            <label htmlFor="chdsh-data-dimension">维度</label>
            <select
              id="chdsh-data-dimension"
              data-dimension-select
              value={dimension}
              onChange={(event) => {
                setDimension(event.target.value as (typeof DIMENSIONS)[number]);
              }}
            >
              {DIMENSIONS.map((item) => <option key={item} value={item}>{DIMENSION_LABELS[item]}</option>)}
            </select>
            {usage.value.rows.filter((row) => row.dimension === dimension).length === 0
              ? <EmptyState>{`这个维度上没有${DIMENSION_LABELS[dimension]}读数。`}</EmptyState>
              : (
                <table data-usage-rows>
                  <caption>{`${DIMENSION_LABELS[dimension]}维度的用量`}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{DIMENSION_LABELS[dimension]}</th>
                      <th scope="col">会话数</th>
                      <th scope="col">文本副本</th>
                      <th scope="col">附件空间</th>
                      <th scope="col">最近活动</th>
                      <th scope="col">保留周期</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usage.value.rows.filter((row) => row.dimension === dimension).map((row) => (
                      <tr key={row.key} data-usage-row={row.key}>
                        <th scope="row">{row.key === '' ? '没有归属记录' : row.key}</th>
                        <td data-session-count={row.sessionCount}>{formatCount(row.sessionCount, '个会话')}</td>
                        <td data-replica-bytes data-bytes={row.textReplicaBytes}>{formatBytes(row.textReplicaBytes)}</td>
                        <td data-attachment-bytes data-bytes={row.attachmentBytes}>{formatBytes(row.attachmentBytes)}</td>
                        <td>{formatTimestamp(row.lastActiveAt)}</td>
                        <td>{`${String(row.retentionDays)} 天`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            <Button onClick={() => { void load(); }}>重新清点</Button>
          </div>
        )
        : null}
    </Panel>
  );
}
