/**
 * 自动化的存储与 webhook 投递处理。
 *
 * 存储只有两张表：自动化记录与投递记录。投递按 `(automation_id, event_id)` 去重，
 * 外部系统重复投递同一事件时只落一行。鉴权按记录里的环境变量名读取密钥，缺失时
 * 按未配置处理并返回 503，不退回「放行」。
 * @module @chatdsh/gateway/automation
 */

import type { DatabaseSync } from 'node:sqlite';
import { AUTOMATION_ERROR_CODES, type AutomationEvent, type AutomationRecord } from '@chatdsh/core-contracts';
import { WebhookInvalidError, normalizeWebhook } from '@chatdsh/forge-bridge';

export type { AutomationEvent, AutomationRecord } from '@chatdsh/core-contracts';

/** 投递结果。 */
export interface WebhookResult {
  /** HTTP 状态码。 */
  readonly status: number;
  /** 响应体。 */
  readonly body: Readonly<Record<string, unknown>>;
}

/** 存储里的一行。 */
interface AutomationRow {
  readonly id: string;
  readonly account_id: string;
  readonly name: string;
  readonly trigger: string;
  readonly action: string;
  readonly enabled: number;
  readonly created_at: number;
}

/** 投递记录的一行。 */
interface EventRow {
  readonly automation_id: string;
  readonly event_id: string;
  readonly received_at: number;
  readonly source: string;
}

/** 行转换成记录。 */
function toRecord(row: AutomationRow): AutomationRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    trigger: JSON.parse(row.trigger) as AutomationRecord['trigger'],
    action: JSON.parse(row.action) as AutomationRecord['action'],
    enabled: row.enabled === 1,
    createdAt: row.created_at,
  };
}

/**
 * 自动化存储。
 *
 * 表在构造时建立；`recordEvent` 用主键冲突判断重复，返回是否首次收下。
 */
export class AutomationStore {
  constructor(private readonly database: DatabaseSync) {
    this.database.exec(`
      create table if not exists automations (
        id text primary key,
        account_id text not null,
        name text not null,
        trigger text not null,
        action text not null,
        enabled integer not null,
        created_at integer not null
      );
      create table if not exists automation_events (
        automation_id text not null,
        event_id text not null,
        received_at integer not null,
        source text not null,
        primary key (automation_id, event_id)
      );
      create index if not exists automations_by_account on automations(account_id);
    `);
  }

  /** 建立一条自动化记录。标识重复时抛出。 */
  create(record: AutomationRecord): void {
    this.database
      .prepare('insert into automations (id, account_id, name, trigger, action, enabled, created_at) values (?, ?, ?, ?, ?, ?, ?)')
      .run(
        record.id,
        record.accountId,
        record.name,
        JSON.stringify(record.trigger),
        JSON.stringify(record.action),
        record.enabled ? 1 : 0,
        record.createdAt,
      );
  }

  /** 读一条记录。 */
  get(id: string): AutomationRecord | undefined {
    const row = this.database
      .prepare('select id, account_id, name, trigger, action, enabled, created_at from automations where id = ?')
      .get(id) as unknown as AutomationRow | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  /** 按账号列出记录。 */
  list(accountId: string): AutomationRecord[] {
    const rows = this.database
      .prepare('select id, account_id, name, trigger, action, enabled, created_at from automations where account_id = ? order by created_at')
      .all(accountId) as unknown as AutomationRow[];
    return rows.map(toRecord);
  }

  /** 记录一次投递；同一事件重复投递返回 false。 */
  recordEvent(event: AutomationEvent): boolean {
    const result = this.database
      .prepare('insert or ignore into automation_events (automation_id, event_id, received_at, source) values (?, ?, ?, ?)')
      .run(event.automationId, event.eventId, event.receivedAt, event.source);
    return Number(result.changes) === 1;
  }

  /** 某个自动化是否已收下过该事件。 */
  hasEvent(automationId: string, eventId: string): boolean {
    const row = this.database
      .prepare('select 1 as hit from automation_events where automation_id = ? and event_id = ?')
      .get(automationId, eventId) as unknown as { hit: number } | undefined;
    return row !== undefined;
  }

  /** 某个自动化的全部投递记录，按接收时间排序。 */
  eventsOf(automationId: string): AutomationEvent[] {
    const rows = this.database
      .prepare('select automation_id, event_id, received_at, source from automation_events where automation_id = ? order by received_at')
      .all(automationId) as unknown as EventRow[];
    return rows.map((row) => ({
      automationId: row.automation_id,
      eventId: row.event_id,
      receivedAt: row.received_at,
      source: row.source as AutomationEvent['source'],
    }));
  }
}

/** 按键名大小写不敏感地取一个头。 */
function headerOf(headers: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

/**
 * 处理一次 webhook 投递。
 *
 * 校验顺序固定：记录存在且启用 → 密钥已配置且匹配 → 请求体合法 → 去重。前两步失败不
 * 读取请求体，避免把未鉴权的载荷交给解析器。
 * @param store - 自动化存储。
 * @param automationId - 路径里的自动化标识。
 * @param headers - 请求头。
 * @param body - 原始请求体。
 * @returns 状态码与响应体。
 */
export function handleWebhook(
  store: AutomationStore,
  automationId: string,
  headers: Readonly<Record<string, string | undefined>>,
  body: string,
): WebhookResult {
  const record = store.get(automationId);
  if (record === undefined) {
    return { status: 404, body: { error: AUTOMATION_ERROR_CODES.notFound } };
  }
  if (!record.enabled) {
    return { status: 404, body: { error: 'automation-disabled' } };
  }
  if (record.trigger.kind !== 'webhook') {
    return { status: 400, body: { error: 'automation-trigger-not-webhook' } };
  }

  const expected = process.env[record.trigger.secretEnv];
  if (expected === undefined || expected === '') {
    return { status: 503, body: { error: 'webhook-secret-unconfigured' } };
  }
  if (headerOf(headers, 'x-chatdsh-webhook-secret') !== expected) {
    return { status: 401, body: { error: AUTOMATION_ERROR_CODES.unauthorized } };
  }

  let event: (Omit<AutomationEvent, 'automationId'> & { automationId: string });
  try {
    event = normalizeWebhook({ headers, body });
  } catch (error) {
    if (error instanceof WebhookInvalidError) {
      return { status: 400, body: { error: error.code, detail: error.message } };
    }
    throw error;
  }

  const accepted = store.recordEvent({ ...event, automationId });
  return { status: 202, body: accepted ? { accepted: true } : { duplicate: true } };
}
