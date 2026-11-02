/**
 * 审批等待、提问与计划接管的遥测。
 *
 * 三个能力共用宿主平面已登记的一组信号：等待用 `chatdsh.runtime.approval.wait` 覆盖耗时与
 * 结果，决定落定写 `chatdsh.runtime.approval.decided`，计数写 `chatdsh_approvals_total`。
 * 三种卡片的差别落在 `approval.kind` 与 `decision` 的枚举值上，指标因此保持有界基数。
 *
 * 属性只放枚举与结果，工具参数、命令文本、计划正文、问题文本与自由输入都不进入遥测。遥测
 * 关闭时这些方法什么都不做，业务路径不依赖遥测返回。
 * @module @chatdsh/host-approval/telemetry
 */

import type { Context } from '@chatdsh/adapter';

/** 等待的信号名。 */
const WAIT_SPAN = 'chatdsh.runtime.approval.wait';

/** 决定落定的事件名。 */
const DECIDED_EVENT = 'chatdsh.runtime.approval.decided';

/** 结果的计数名。 */
const APPROVALS_METRIC = 'chatdsh_approvals_total';

/** 卡片种类。 */
export type ApprovalKind = 'approval' | 'question' | 'plan';

/** span 的最小形状。 */
export interface SpanLike {
  setAttribute(key: string, value: string | number | boolean): void;
}

/** 遥测面的最小形状，与宿主平面统一客户端的同名方法一致。 */
export interface ApprovalTelemetry {
  runSpan<T>(
    name: string,
    attributes: Readonly<Record<string, string | number | boolean>>,
    fn: (span: SpanLike) => Promise<T>,
  ): Promise<T>;
  event(name: string, attributes?: Readonly<Record<string, string | number | boolean>>, body?: string): void;
  counter(name: string, options?: { readonly description?: string }): {
    add(value: number, attributes?: Readonly<Record<string, string | number | boolean>>): void;
  };
}

/**
 * 取宿主遥测面。
 * @param ctx - 宿主上下文。
 * @returns 遥测面；遥测关闭或未安装时为 `undefined`。
 */
export function approvalTelemetryOf(ctx: Context): ApprovalTelemetry | undefined {
  return ctx.reflect.get('chatdshTelemetry') as ApprovalTelemetry | undefined;
}

/**
 * 在一个等待 span 里执行等待。
 * @param telemetry - 遥测面。
 * @param kind - 卡片种类。
 * @param failureDecision - 等待以失败收场时记录的枚举值。
 * @param fn - 等待主体，返回结果与决定的枚举值。
 * @returns 等待主体的返回值。
 */
export async function runWaitSpan<T>(
  telemetry: ApprovalTelemetry | undefined,
  kind: ApprovalKind,
  failureDecision: string,
  fn: () => Promise<{ readonly value: T; readonly decision: string }>,
): Promise<T> {
  if (telemetry === undefined) return (await fn()).value;
  return telemetry.runSpan(WAIT_SPAN, { 'approval.kind': kind }, async (span) => {
    try {
      const { value, decision } = await fn();
      span.setAttribute('decision', decision);
      return value;
    } catch (error) {
      span.setAttribute('decision', failureDecision);
      throw error;
    }
  });
}

/**
 * 记一次决定落定。
 * @param telemetry - 遥测面。
 * @param kind - 卡片种类。
 * @param decision - 结果枚举值。
 * @param decidedBy - 作出决定的客户端。
 */
export function recordDecision(
  telemetry: ApprovalTelemetry | undefined,
  kind: ApprovalKind,
  decision: string,
  decidedBy: string,
): void {
  if (telemetry === undefined) return;
  telemetry.event(DECIDED_EVENT, { decision, 'decided_by': decidedBy });
  telemetry.counter(APPROVALS_METRIC, { description: '审批、提问与计划接管的结果' }).add(1, { kind, decision });
}
