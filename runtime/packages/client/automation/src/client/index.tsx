/**
 * 自动化面板：列出自动化并给出启停入口。
 *
 * 数据经控制平面的 `/chatdsh/gateway/automations` 取得（Remote 命名空间
 * `chatdshGatewayAutomation`）。启停失败只显示提示，不改本地列表；用户操作补一条
 * `chatdsh.client.ui.action` 事件到浏览器侧遥测队列。
 * @module @chatdsh/client-automation
 */

import { useEffect, useState } from 'react';
import { formatAutomationSummary } from '../index.ts';
import { Badge, Button, EmptyState, List, Panel, Row, Skeleton, StatusLine } from '@chatdsh/core-ui-kit';

/** 一条自动化记录。 */
interface AutomationRecord {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
}

/** 浏览器侧上下文的可用面。 */
interface ClientFace {
  readonly remote?: {
    readonly chatdshGatewayAutomation?: {
      list?: () => Promise<AutomationRecord[]>;
      toggle?: (id: string, enabled: boolean) => Promise<{ id: string; enabled: boolean }>;
    };
  };
}

/** 席位名。 */
export const SECTION_SLOT = 'settings.section';

/** 区段标识。 */
export const SECTION_ID = 'chatdsh-automation';

/** 浏览器侧依赖：只等席位服务。 */
export const inject = ['slots'];

let clientFace: ClientFace | undefined;

/** 记录一次界面动作，失败不打断界面。 */
function noteAction(outcome: 'ok' | 'failed'): void {
  // 浏览器侧不持有 OpenObserve 凭据，直接编成 OTLP 日志载荷交给同源中继；
  // 中继只转发不解析，形状必须与 client-telemetry 生成的一致。
  void fetch('/chatdsh/telemetry/browser', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-chatdsh-signal': 'logs', 'x-chatdsh-csrf': '1' },
    body: JSON.stringify({
    resourceLogs: [{
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: 'chatdsh-browser' } },
          { key: 'chatdsh.surface', value: { stringValue: 'browser' } },
        ],
      },
      scopeLogs: [{
        scope: { name: '@chatdsh/client-automation' },
        logRecords: [{
          timeUnixNano: String(Date.now() * 1_000_000),
          severityNumber: 9,
          severityText: 'INFO',
          body: { stringValue: 'chatdsh.client.ui.action' },
          attributes: [
            { key: 'action', value: { stringValue: 'automation-toggle' } },
            { key: 'outcome', value: { stringValue: outcome } },
          ],
        }],
      }],
    }],
  }),
    keepalive: true,
  }).catch(() => undefined);
}

/**
 * 注册设置页区段。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientFace & { slots: ClientSlots }): void {
  clientFace = ctx;
  ctx.slots.inject(SECTION_SLOT, () => ctx.slots.register({
    name: SECTION_SLOT,
    id: SECTION_ID,
    order: 48,
    label: () => '自动化',
    locale: 'chatdsh.automation',
  }, AutomationSection));
}

/** 设置页区段。 */
export function AutomationSection() {
  const [records, setRecords] = useState<AutomationRecord[] | undefined>(undefined);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = clientFace?.remote?.chatdshGatewayAutomation?.list;
    if (load === undefined) {
      setFailed(true);
      return;
    }
    load.call(clientFace?.remote?.chatdshGatewayAutomation).then(
      (items) => {
        if (!cancelled) setRecords(items);
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  function toggle(record: AutomationRecord): void {
    const remote = clientFace?.remote?.chatdshGatewayAutomation;
    if (remote?.toggle === undefined) return;
    remote.toggle.call(remote, record.id, !record.enabled).then(
      (result) => {
        noteAction('ok');
        setRecords((current) => (current ?? []).map((item) => (item.id === result.id ? { ...item, enabled: result.enabled } : item)));
      },
      () => noteAction('failed'),
    );
  }

  if (failed) return <Panel title="自动化"><StatusLine tone="danger">自动化列表暂不可用。</StatusLine></Panel>;
  if (records === undefined) return <Panel title="自动化"><Skeleton rows={3} /></Panel>;
  if (records.length === 0) return <Panel title="自动化"><EmptyState>{formatAutomationSummary(records)}</EmptyState></Panel>;

  return (
    <Panel title="自动化" subtitle={formatAutomationSummary(records)} count={`${records.length}`}>
      <List>
        {records.map((record) => (
          <Row
            key={record.id}
            dot={record.enabled ? 'ok' : 'idle'}
            title={record.name}
            badge={<Badge tone={record.enabled ? 'ok' : 'neutral'}>{record.enabled ? '启用' : '已停用'}</Badge>}
            actions={<Button onClick={() => toggle(record)}>{record.enabled ? '停用' : '启用'}</Button>}
          />
        ))}
      </List>
    </Panel>
  );
}

/** 席位服务的最小形状。 */
interface ClientSlots {
  inject(key: string, callback: () => () => void): () => void;
  register(spec: { name: string; id?: string; order?: number; label?: () => string; locale?: string }, Component: () => unknown): () => void;
}
