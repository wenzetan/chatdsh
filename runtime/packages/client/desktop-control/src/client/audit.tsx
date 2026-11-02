/**
 * 审计记录面板。
 *
 * 每次授权、动作、暂停、中断与撤销都在这里列出来：时间、种类、作用范围、期限与结果。记录
 * 来自宿主的审计文件，面板只读取与展示。
 * @module @chatdsh/client-desktop-control/audit
 */

import { Button, List, Row, StatusLine } from '@chatdsh/core-ui-kit';
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { ControlCallError } from './gateway.ts';
import { describeAuditEntry } from './lease.ts';
import { ERROR_LABELS, type AuditEntry, type ControlGateway, type ControlTelemetry } from './types.ts';
import { browserTelemetry } from './telemetry.ts';

/** 审计面板属性。 */
export interface AuditPanelProps {
  /** 数据入口。 */
  readonly gateway: ControlGateway;
  /** 界面动作遥测。 */
  readonly telemetry?: ControlTelemetry;
  /** 最多显示的条数。 */
  readonly limit?: number;
}

/** 把异常换成一句说明。 */
function explain(error: unknown): string {
  if (error instanceof ControlCallError) return error.message;
  if (error instanceof Error && error.message !== '') return error.message;
  return ERROR_LABELS['control-failed'] as string;
}

/**
 * 桌面控制审计面板。
 * @param props - 数据入口与条数上限。
 * @returns 面板内容。
 */
export function AuditPanel({ gateway, telemetry = browserTelemetry, limit = 20 }: AuditPanelProps): ReactElement {
  const [entries, setEntries] = useState<readonly AuditEntry[] | undefined>(undefined);
  const [failure, setFailure] = useState<string | undefined>(undefined);

  const load = useCallback(async (): Promise<void> => {
    try {
      const next = await gateway.audit(limit);
      setEntries(next);
      setFailure(undefined);
      telemetry.action('control-audit-open', 'ok');
    } catch (error) {
      setFailure(explain(error));
      telemetry.action('control-audit-open', 'failed');
    }
  }, [gateway, limit, telemetry]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section id="chdsh-control-audit" className="chdsh-control-audit" aria-label="桌面控制审计">
      <div className="chdsh-control-audit__head">
        <h3 className="chdsh-panel__title">桌面控制审计</h3>
        <Button id="chdsh-control-audit-refresh" onClick={() => void load()}>刷新记录</Button>
      </div>
      {failure === undefined ? null : <p className="chdsh-error" role="alert">{failure}</p>}
      {entries === undefined ? <StatusLine>正在读取审计记录…</StatusLine> : null}
      {entries !== undefined && entries.length === 0 ? <StatusLine>还没有记录。</StatusLine> : null}
      {entries === undefined || entries.length === 0 ? null : (
        <List>
          {entries.map((entry, index) => {
            const view = describeAuditEntry(entry);
            return (
              <Row
                key={`${entry.at}-${index}`}
                dot={entry.outcome === 'granted' || entry.outcome === 'ok' ? 'ok' : entry.outcome === 'denied' ? 'danger' : 'warn'}
                title={`${view.kind}：${view.outcome}`}
                meta={<span>
                  {view.at} · 范围 {view.scope} · 期限 {view.expires}
                  {entry.detail === undefined ? '' : ` · ${entry.detail}`}
                  {entry.action === undefined ? '' : ` · 动作 ${entry.action}`}
                </span>}
              />
            );
          })}
        </List>
      )}
    </section>
  );
}
