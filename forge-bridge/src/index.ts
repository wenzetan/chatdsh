/**
 * 外部事件的规范化。
 *
 * GitHub 与通用 webhook 的投递到达控制平面时形状不同：GitHub 用 `X-GitHub-Event` 与
 * `X-GitHub-Delivery` 两个头，通用投递没有约定。这里把两者收成同一种
 * {@link AutomationEvent}：来源由头判定，事件标识优先取投递头，缺省按请求体摘要生成，
 * 保证同一份请求体重复投递时得到同一个标识，从而可以按标识去重。
 * @module @chatdsh/forge-bridge
 */

import { createHash } from 'node:crypto';
import { AUTOMATION_ERROR_CODES, type AutomationEvent } from '@chatdsh/core-contracts';

export type { AutomationEvent, AutomationEventSource } from '@chatdsh/core-contracts';

/** 投递不合法。 */
export class WebhookInvalidError extends Error {
  /** 固定错误码，供网关的遥测与响应体使用。 */
  readonly code = AUTOMATION_ERROR_CODES.invalid;

  constructor(message: string) {
    super(message);
    this.name = 'WebhookInvalidError';
  }
}

/** 输入：请求头与原始请求体。 */
export interface WebhookInput {
  /** 请求头，键大小写不敏感。 */
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** 原始请求体文本。 */
  readonly body: string;
}

/** 按键名大小写不敏感地取一个头。 */
function headerOf(headers: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

/** 按请求体摘要生成事件标识。 */
function digestOf(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 32);
}

/**
 * 把一次外部投递规范化成自动化事件。
 * @param input - 请求头与原始请求体。
 * @returns 规范化后的事件；`automationId` 由调用方按命中的记录填入，这里留空字符串。
 * @throws {@link WebhookInvalidError} 请求体为空或不是 JSON 对象。
 */
export function normalizeWebhook(input: WebhookInput): Omit<AutomationEvent, 'automationId'> & { automationId: string } {
  if (input.body.trim() === '') throw new WebhookInvalidError('请求体为空');
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.body);
  } catch {
    throw new WebhookInvalidError('请求体不是合法 JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new WebhookInvalidError('请求体必须是 JSON 对象');
  }

  const source = headerOf(input.headers, 'x-github-event') === undefined ? 'generic' : 'github';
  const delivery = headerOf(input.headers, 'x-github-delivery');
  return {
    automationId: '',
    eventId: delivery === undefined || delivery === '' ? digestOf(input.body) : delivery,
    receivedAt: Date.now(),
    source,
    payload: parsed as Readonly<Record<string, unknown>>,
  };
}
