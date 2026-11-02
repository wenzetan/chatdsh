/**
 * 持续指示条。
 *
 * 授权有效期间固定在视口顶部，显示目标应用、已运行时长、授权期限，并给出暂停与立即结束两个
 * 动作。状态每秒刷新一次，多个窗口各自读取同一份宿主状态，因此任何窗口里按下中断，其他窗口
 * 的下一次刷新就会看到同一个结果。
 * @module @chatdsh/client-desktop-control/indicator
 */

import { Badge, Button } from '@chatdsh/core-ui-kit';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { ControlCallError } from './gateway.ts';
import {
  canInterrupt,
  canPause,
  elapsedOf,
  formatDuration,
  indicatorSummary,
  isLeaseActive,
  leaseStatusLabel,
  scopeLabel,
  targetLabel,
} from './lease.ts';
import { ERROR_LABELS, type ControlGateway, type ControlState, type ControlTelemetry } from './types.ts';
import { browserTelemetry } from './telemetry.ts';

/** 指示条属性。 */
export interface ControlIndicatorProps {
  /** 数据入口。 */
  readonly gateway: ControlGateway;
  /** 界面动作遥测。 */
  readonly telemetry?: ControlTelemetry;
  /** 刷新间隔，毫秒。 */
  readonly pollIntervalMs?: number;
  /** 当前时刻的实现，测试可以固定时钟。 */
  readonly clock?: () => number;
}

/** 把异常换成一句说明。 */
function explain(error: unknown): string {
  if (error instanceof ControlCallError) return error.message;
  if (error instanceof Error && error.message !== '') return error.message;
  return ERROR_LABELS['control-failed'] as string;
}

/**
 * 桌面控制持续指示条。
 * @param props - 数据入口、刷新间隔与时钟。
 * @returns 指示条。
 */
export function ControlIndicator({ gateway, telemetry = browserTelemetry, pollIntervalMs = 1_000, clock = () => Date.now() }: ControlIndicatorProps): ReactElement | null {
  const [state, setState] = useState<ControlState | undefined>(undefined);
  const [fetchedAt, setFetchedAt] = useState(0);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => clock());
  const alive = useRef(true);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await gateway.state();
      if (!alive.current) return;
      setState(next);
      setFetchedAt(clock());
      setFailure(undefined);
    } catch (error) {
      if (!alive.current) return;
      setFailure(explain(error));
    }
  }, [gateway, clock]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const poll = setInterval(() => void refresh(), pollIntervalMs);
    const tick = setInterval(() => setNow(clock()), 1_000);
    return () => {
      alive.current = false;
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [refresh, pollIntervalMs, clock]);

  const act = async (kind: 'pause' | 'resume' | 'interrupt'): Promise<void> => {
    setBusy(true);
    setFailure(undefined);
    try {
      const next = kind === 'interrupt'
        ? await gateway.interrupt('用户按下中断')
        : await gateway.pause(kind === 'pause');
      setState(next);
      setFetchedAt(clock());
      telemetry.action(kind === 'interrupt' ? 'control-interrupt' : `control-${kind}`, 'ok');
    } catch (error) {
      setFailure(explain(error));
      telemetry.action(kind === 'interrupt' ? 'control-interrupt' : `control-${kind}`, 'failed');
    } finally {
      setBusy(false);
    }
  };

  if (state === undefined || state.lease === undefined) {
    return failure === undefined ? null : <p className="chdsh-error" role="alert">{failure}</p>;
  }

  const lease = state.lease;
  const current = state.now + Math.max(0, now - fetchedAt);
  const live = isLeaseActive(lease);
  const elapsed = formatDuration(elapsedOf({ ...state, now: current }));
  const remaining = formatDuration(live ? Math.max(0, lease.expiresAt - current) : 0);

  return (
    <div
      id="chdsh-control-indicator"
      className={`chdsh-control-bar${live ? '' : ' chdsh-control-bar--ended'}`}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-lease-status={lease.status}
      data-lease-id={lease.leaseId}
      data-remaining-ms={live ? Math.max(0, lease.expiresAt - current) : 0}
    >
      <span className={`chdsh-dot${live ? ' chdsh-dot--warn' : ''}`} aria-hidden="true" />
      <span className="chdsh-control-bar__label">
        <span id="chdsh-control-summary">{indicatorSummary({ ...state, now: current })}</span>
        <span className="chdsh-control-bar__detail">
          <span id="chdsh-control-target">目标：{targetLabel(lease.scope)}</span>
          <span id="chdsh-control-scope">{scopeLabel(lease.scope)}</span>
          <span id="chdsh-control-elapsed">已运行 {elapsed}</span>
          <span id="chdsh-control-remaining">{live ? `剩余 ${remaining}` : `结束于 ${new Date(lease.endedAt ?? current).toLocaleTimeString('zh-CN', { hour12: false })}`}</span>
          <Badge tone={live ? 'warn' : 'neutral'}>{leaseStatusLabel(lease)}</Badge>
        </span>
      </span>
      <span className="chdsh-control-bar__acts">
        {canPause({ ...state, now: current }) ? (
          <Button id="chdsh-control-pause" disabled={busy} onClick={() => void act(lease.status === 'paused' ? 'resume' : 'pause')}>
            {lease.status === 'paused' ? '继续' : '暂停'}
          </Button>
        ) : null}
        {canInterrupt({ ...state, now: current }) ? (
          <Button id="chdsh-control-interrupt" tone="danger" disabled={busy} onClick={() => void act('interrupt')}>立即结束</Button>
        ) : null}
      </span>
      {failure === undefined ? null : <span className="chdsh-error" role="alert">{failure}</span>}
    </div>
  );
}
