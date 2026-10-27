/**
 * 自动化面板：列出自动化并给出启停入口。
 *
 * 数据经控制平面的 `/chatdsh/gateway/automations` 取得。启停失败只显示提示，不改本地
 * 列表；用户操作补一条 `chatdsh.client.ui.action` 事件到浏览器侧遥测队列。
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

/** 控制平面的自动化接口。 */
export const AUTOMATIONS_PATH = '/chatdsh/gateway/automations';

/** 写操作要求的请求头，与分享、遥测端点一致，跨站表单无法携带。 */
export const CSRF_HEADER = 'x-chatdsh-csrf';

/** 席位名。 */
export const SECTION_SLOT = 'settings.section';

/** 区段标识。 */
export const SECTION_ID = 'chatdsh-automation';

/** 浏览器侧依赖：只等席位服务。 */
export const inject = ['slots'];

/** 记录一次界面动作，失败不打断界面。 */
function noteAction(outcome: 'ok' | 'failed'): void {
  // 浏览器侧不持有 OpenObserve 凭据，直接编成 OTLP 日志载荷交给同源中继；
  // 中继只转发不解析，形状必须与 client-telemetry 生成的一致。
  void fetch('/chatdsh/telemetry/browser', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-chatdsh-signal': 'logs', [CSRF_HEADER]: '1' },
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

/** 读取自动化列表。 */
async function loadAutomations(): Promise<AutomationRecord[]> {
  const response = await fetch(AUTOMATIONS_PATH);
  if (!response.ok) throw new Error(`自动化列表返回 ${response.status}`);
  const payload = (await response.json()) as { automations?: AutomationRecord[] };
  return payload.automations ?? [];
}

/** 切换一条自动化的启用状态。 */
async function toggleAutomation(id: string, enabled: boolean): Promise<AutomationRecord> {
  const response = await fetch(AUTOMATIONS_PATH, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', [CSRF_HEADER]: '1' },
    body: JSON.stringify({ id, enabled }),
  });
  if (!response.ok) throw new Error(`自动化切换返回 ${response.status}`);
  return response.json() as Promise<AutomationRecord>;
}

/**
 * 注册设置页区段。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: { slots: ClientSlots }): void {
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
  const [busy, setBusy] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    loadAutomations().then(
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
    setBusy(record.id);
    toggleAutomation(record.id, !record.enabled).then(
      (result) => {
        noteAction('ok');
        setBusy(undefined);
        setRecords((current) => (current ?? []).map((item) => (item.id === result.id ? { ...item, enabled: result.enabled } : item)));
      },
      () => {
        noteAction('failed');
        setBusy(undefined);
        setFailed(true);
      },
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
            actions={<Button disabled={busy === record.id} onClick={() => toggle(record)}>{record.enabled ? '停用' : '启用'}</Button>}
          />
        ))}
      </List>
    </Panel>
  );
}

/** 席位服务的最小形状。 */
interface ClientSlots {
  inject(key: string, callback: () => void): () => void;
  register(spec: { name: string; id?: string; order?: number; label?: () => string; locale?: string }, Component: () => unknown): () => void;
}
