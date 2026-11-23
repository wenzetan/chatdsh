/**
 * DSH 内部 API 的唯一接触面。
 *
 * 只转出 ChatDSH 插件实际依赖的顶层稳定服务、会话契约、事件名与白名单设置命名空间，
 * 不暴露内部工具行或界面实现细节，将上游升级的变更面收敛在单个包内。
 * @module @chatdsh/adapter
 */

export { Service } from '@deepseek-ai/cordis';
export type { Context } from '@deepseek-ai/cordis';
export { default as schema } from '@deepseek-ai/schemastery';
export { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';

export type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session';
export {
  SessionPersistence,
  SessionPersistenceNotFoundError,
} from '@deepseek-ai/dsh-session-persistence';

import type {} from '@deepseek-ai/dsh-host-webserver';
import type {} from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-persistence';

export {
  SESSION_EVENTS,
  SESSION_EVENT_TYPES,
} from './events.ts';
export type {
  SessionEventName,
  SessionEventType,
} from './events.ts';
export {
  UPSTREAM_BUNDLES,
  UPSTREAM_CLIENT_UI,
  UPSTREAM_PACKAGE_NAMES,
} from './upstream.ts';
export {
  connectionOf,
  hostWebServerOf,
  sessionPersistenceOf,
  sessionsOf,
  telemetryOf,
} from './services.ts';
