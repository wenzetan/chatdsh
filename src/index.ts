/**
 * DSH 内部 API 的唯一接触面。
 *
 * 上游的包名、事件名与 `ctx` 服务名散落在几十个文件里时，一次上游升级要改的
 * 位置就跟着文件数增长。这一层把它们收在一处：业务包从这里取，不直接 import
 * 上游内部包，也不直接写事件名字面量与服务名。
 *
 * 收拢的边界是「上游内部 API 的引用」，不含业务能力：这里只做转出与薄封装，
 * 不实现任何业务逻辑。改动这一层就够跟着上游走，业务包不用动。
 *
 * 新增上游引用时先在这里登记，再由业务包引用；`check-plugin-contract.mjs` 会
 * 拦住绕过这一层的直接 import。
 * @module @chatdsh/adapter
 */

// ── 框架：插件契约 ────────────────────────────────────────────────
// 服务基类与上下文类型。这两个是 cordis 的公开面，稳定度最高，但仍然只在这里转出，
// 这样上游若调整基类名或构造签名，改动落在一个文件里。
export { Service } from '@deepseek-ai/cordis';
export type { Context } from '@deepseek-ai/cordis';

// ── 框架：配置 schema ────────────────────────────────────────────
// schemastery 的默认导出在各处被写成 `sz` 或 `z`，这里统一叫 `schema`。
export { default as schema } from '@deepseek-ai/schemastery';

// ── 框架：Remote 服务 ────────────────────────────────────────────
// `Remote` 是方法装饰器，`TypertRemoteService` 是远端服务的基类。
// 上游若调整远端服务的基类或装饰器语义，改这里。
export { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';

// ── 工具注册 ────────────────────────────────────────────────────
// `defineTool` 是工具定义的构造入口，参数校验与 schema 转换都由它承担。
export { defineTool } from '@deepseek-ai/dsh-tools';
export type { DefineToolOptions } from '@deepseek-ai/dsh-tools';

// ── 结构化存储 ──────────────────────────────────────────────────
// `defineDomain` 声明一个存储域，`domainTable` 造一张表。
export { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';

// ── 会话类型 ────────────────────────────────────────────────────
// 会话标识是品牌类型，会话与事件类型用于签名。
export type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session';

// ── agent preset ────────────────────────────────────────────────
// 预设定义的形状，用于把助手记录装配成 preset。
export type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry';

// ── 加载器 ──────────────────────────────────────────────────────
// 加载器条目的配置形状，用于把连接器记录同步成 MCP 客户端行。
export type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader';

// ── 类型声明补齐 ────────────────────────────────────────────────
// 下面这些包只提供类型增强（事件表、服务面），运行时不需要它们的导出。
// 引入它们是为了让 `ctx` 上的服务名与事件名在类型层面可解析。
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-agent-preset-registry';
import type {} from '@deepseek-ai/dsh-host-webserver';
import type {} from '@deepseek-ai/dsh-otel';
import type {} from '@deepseek-ai/dsh-session-persistence';
import type {} from '@deepseek-ai/dsh-session-projection';
import type {} from '@deepseek-ai/dsh-settings';
import type {} from '@deepseek-ai/dsh-storage-domain';
import type {} from '@deepseek-ai/dsh-system-prompt';
import type {} from '@deepseek-ai/dsh-user-approval';
import type {} from '@deepseek-ai/cordis-plugin-loader';

export { AGENT_EVENTS, SESSION_EVENTS, APPROVAL_EVENTS, SESSION_EVENT_TYPES } from './events.ts';
export type { AgentEventName, SessionEventName, ApprovalEventName, SessionEventType } from './events.ts';
export {
  agentPresetsOf,
  hostWebServerOf,
  loaderOf,
  otelOf,
  sessionPersistenceOf,
  sessionProjectionsOf,
  sessionsOf,
  settingsOf,
  storageDomainOf,
  systemPromptOf,
  toolsOf,
  telemetryOf,
} from './services.ts';
