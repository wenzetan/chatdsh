/**
 * 上游 `ctx` 服务名的唯一接触面。
 * @module @chatdsh/adapter/services
 */

import type { Context } from '@deepseek-ai/cordis';
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection';
import type { WebServer } from '@deepseek-ai/dsh-host-webserver';
import type { SessionStore } from '@deepseek-ai/dsh-session';
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence';

/** 会话注册表：`ctx.sessions`。 */
export function sessionsOf(ctx: Context): SessionStore {
  return ctx.sessions;
}

/** 会话持久化：`ctx.sessionPersistence`。 */
export function sessionPersistenceOf(ctx: Context): SessionPersistence {
  return ctx.sessionPersistence;
}

/** HTTP 服务：`ctx.webServer`。 */
export function hostWebServerOf(ctx: Context): WebServer {
  return ctx.webServer;
}

/**
 * 浏览器连接服务：`ctx.connection`。
 * 仅在包含 Web 前端的 profile 里存在，未挂载时返回 `undefined`。
 */
export function connectionOf(ctx: Context): HostConnectionHandle | undefined {
  return ctx.reflect.get('connection') as HostConnectionHandle | undefined;
}

/**
 * 宿主平面遥测服务：`ctx.chatdshTelemetry`。
 * 按名读取，未安装遥测插件或遥测关闭时返回 `undefined`。
 */
export function telemetryOf<T>(ctx: Context): T | undefined {
  return ctx.reflect.get('chatdshTelemetry') as T | undefined;
}
