/**
 * 上游 `ctx` 服务名的唯一接触面。
 *
 * `ctx.<服务名>` 是字符串键上的属性访问：上游改名在编译期不一定报错（服务表是
 * 合并接口），运行期则表现为「取到 undefined」。这里把服务名与取值方式收在一处。
 *
 * 取值方式有两种。声明在 `inject` 里的服务用属性访问，类型由上游的类型增强给出；
 * 可选服务（例如遥测在 ACP 形态下不存在）用 `ctx.reflect.get`，取不到时返回
 * `undefined`，由调用方决定降级行为。
 * @module @chatdsh/adapter/services
 */

import type { Context } from '@deepseek-ai/cordis';
import type { Loader } from '@deepseek-ai/cordis-plugin-loader';
import type { ToolRuntime } from '@deepseek-ai/dsh-tools';
import type { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import type { SessionStore } from '@deepseek-ai/dsh-session';
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence';
import type { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import type { AgentPresetRegistry } from '@deepseek-ai/dsh-agent-preset-registry';
import type { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import type { WebServer } from '@deepseek-ai/dsh-host-webserver';
import type { SettingsForms } from '@deepseek-ai/dsh-settings';
import type { LlmRuntime } from '@deepseek-ai/dsh-llm';
import type { SkillRegistry } from '@deepseek-ai/dsh-skill';
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent';
import type { ScheduleService } from '@deepseek-ai/dsh-schedule';
import type { WorktreeService } from '@deepseek-ai/dsh-experimental-worktree';

/** 工具注册表：`ctx.tools`。 */
export function toolsOf(ctx: Context): ToolRuntime {
  return ctx.tools;
}

/** 结构化存储设施：`ctx.storageDomain`。 */
export function storageDomainOf(ctx: Context): DomainFacility {
  return ctx.storageDomain;
}

/** 会话注册表：`ctx.sessions`。 */
export function sessionsOf(ctx: Context): SessionStore {
  return ctx.sessions;
}

/** 会话持久化：`ctx.sessionPersistence`。 */
export function sessionPersistenceOf(ctx: Context): SessionPersistence {
  return ctx.sessionPersistence;
}

/** 会话投影注册表：`ctx.sessionProjections`。 */
export function sessionProjectionsOf(ctx: Context): SessionProjectionRegistry {
  return ctx.sessionProjections;
}

/** agent preset 注册表：`ctx.agentPresets`。 */
export function agentPresetsOf(ctx: Context): AgentPresetRegistry {
  return ctx.agentPresets;
}

/** 系统提示服务：`ctx.systemPrompt`。 */
export function systemPromptOf(ctx: Context): SystemPrompt {
  return ctx.systemPrompt;
}

/** 加载器：`ctx.loader`。 */
export function loaderOf(ctx: Context): Loader {
  return ctx.loader;
}

/** HTTP 服务：`ctx.webServer`。 */
export function hostWebServerOf(ctx: Context): WebServer {
  return ctx.webServer;
}

/** 设置面：`ctx.settings`。 */
export function settingsOf(ctx: Context): SettingsForms {
  return ctx.settings;
}

/** 模型运行时：`ctx.llm`，提供适配器注册与流式调用。 */
export function llmOf(ctx: Context): LlmRuntime {
  return ctx.llm;
}

/** 技能目录：`ctx.skills`。 */
export function skillsOf(ctx: Context): SkillRegistry {
  return ctx.skills;
}

/** 子代理运行时：`ctx.subagents`，命名提供方注册表。 */
export function subagentsOf(ctx: Context): SubagentRuntime {
  return ctx.subagents;
}

/** 定时任务：`ctx.schedule`。 */
export function scheduleOf(ctx: Context): ScheduleService {
  return ctx.schedule;
}

/** 工作树服务：`ctx.worktrees`。 */
export function worktreesOf(ctx: Context): WorktreeService {
  return ctx.worktrees;
}

/**
 * OTel 通道：`ctx.otel`。
 *
 * 上游的 OTel 服务是默认导出的类，类型由 `dsh-otel` 的模块增强挂到 `ctx` 上；
 * 这里用 `Context['otel']` 取它的类型，避免再引一次默认导出。
 * @param ctx - 上下文。
 * @returns OTel 服务。
 */
export function otelOf(ctx: Context): Context['otel'] {
  return ctx.otel;
}

/**
 * 遥测服务：`ctx.chatdshTelemetry`。
 *
 * 这是自建服务，不是上游的。它按名读取而不是声明 `inject`，因为在 ACP 这类没有
 * 宿主平面遥测的形态里，插件仍要能装载——缺少遥测时调用方按无遥测降级。
 * @param ctx - 上下文。
 * @returns 遥测服务；未安装时 `undefined`。
 */
export function telemetryOf<T>(ctx: Context): T | undefined {
  return ctx.reflect.get('chatdshTelemetry') as T | undefined;
}
