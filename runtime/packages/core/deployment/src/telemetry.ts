/**
 * 部署信号的统一出口。
 *
 * 每个拒绝分支同时写一条 span 属性、一条带错误码的事件与一次计数，三处名字在包清单里声明。
 * @module @chatdsh/core-deployment/telemetry
 */

import type { ChatdshTelemetry, TelemetrySpan } from '@chatdsh/core-contracts';
import type { DeploymentErrorType } from './errors.ts';

/** 一次拒绝要记录的信息。 */
export interface RejectionRecord {
  /** 被拒绝的动作，取值是固定枚举。 */
  readonly action: string;
  /** 拒绝来源分类。 */
  readonly errorType: DeploymentErrorType;
  /** 稳定错误码。 */
  readonly errorCode: string;
  /** 正在进行的 span；没有时只写事件与计数。 */
  readonly span?: TelemetrySpan;
  /** 地址分类或监听归属一类的固定枚举。 */
  readonly kind?: string;
  /** 传输形态：`mtls`、`tls` 或 `plaintext`。 */
  readonly mode?: string;
}

/**
 * 记录一次拒绝。
 * @param telemetry - 遥测客户端。
 * @param record - 动作、错误码与可选的上下文。
 */
export function emitRejection(telemetry: ChatdshTelemetry, record: RejectionRecord): void {
  record.span?.setAttribute('outcome', 'rejected');
  record.span?.setAttribute('error.type', record.errorType);
  record.span?.setAttribute('error.code', record.errorCode);
  telemetry.event('chatdsh.gateway.deploy.rejected', {
    action: record.action,
    ...(record.kind === undefined ? {} : { kind: record.kind }),
    ...(record.mode === undefined ? {} : { mode: record.mode }),
    outcome: 'rejected',
    'error.type': record.errorType,
    'error.code': record.errorCode,
  });
  telemetry.counter('chatdsh_gateway_deploy_rejections_total', { description: '传输与部署拒绝次数' }).add(1, {
    action: record.action,
    'error.code': record.errorCode,
  });
}
