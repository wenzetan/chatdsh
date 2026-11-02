/**
 * 技能目录宿主插件。
 *
 * 启动时从 `ctx.skills` 读一次目录（异步发现），按来源映射成本项目的三类；运行期只改
 * 启用状态，不重新扫描。停用只影响本项目的目录视图与 `skill_manage` 工具，不改变上游
 * 提供方自己的注册。
 *
 * 启用决定写进结构化存储，重启后重新扫描再加盖这些决定，因此重启不会把已停用的技能
 * 重新打开。检索按标识、名称与说明做包含匹配，并可限定来源。
 * @module @chatdsh/host-skills
 */

import { ChatdshError, type ChatdshErrorCode } from '@chatdsh/core-contracts';
import { Remote, skillsOf, storageDomainOf, telemetryOf, TypertRemoteService, type Context } from '@chatdsh/adapter';
import type {} from '@deepseek-ai/dsh-skill';
import {
  createSkillCatalog,
  type SkillCatalog,
  type SkillCatalogState,
  type SkillEntry,
  type SkillOverride,
  type SkillSearchRequest,
  type SkillSourceKind,
} from './registry.ts';
import { SKILLS_DOMAIN, type SkillOverrideRecord } from './domain.ts';

export { createSkillCatalog, SKILL_LIMIT, SKILL_QUERY_LIMIT, SKILL_SOURCES } from './registry.ts';
export type {
  SkillCatalog,
  SkillCatalogState,
  SkillEntry,
  SkillOverride,
  SkillSearchRequest,
  SkillSeed,
  SkillSourceKind,
} from './registry.ts';
export { SKILLS_DOMAIN, skillOverrideSchema } from './domain.ts';
export type { SkillOverrideRecord } from './domain.ts';

/** 插件名。 */
export const name = 'chatdsh-skills';

/** 服务名，同时是 Remote 命名空间。 */
export const SERVICE_NAME = 'chatdshSkills';

/**
 * 上游来源到本项目来源的映射。
 * @param source - 上游的技能来源标识。
 * @returns 本项目三类来源之一；未知来源按 user 处理，避免丢掉自定义提供方的技能。
 */
export function sourceKindOf(source: string): SkillSourceKind {
  if (source === 'bundled' || source === 'runtime') return 'builtin';
  if (source.startsWith('project-')) return 'workspace';
  return 'user';
}

/** 遥测 span 用到的最小接口。 */
type SpanLike = { setAttribute(key: string, value: unknown): void };

/** 用到的遥测面。 */
interface SkillsTelemetry {
  runSpan<T>(name: string, attributes: Record<string, unknown>, body: (span: SpanLike) => Promise<T>): Promise<T>;
  counter(name: string, options?: { description: string }): { add(delta: number, attributes?: Record<string, unknown>): void };
  event(name: string, attributes?: Record<string, unknown>): void;
}

/** 只用到四个方法的键值表。 */
interface Table<V> {
  get(key: string): V | undefined;
  entries(): IterableIterator<[string, V]>;
  put(key: string, value: V): Promise<void>;
  delete(key: string): Promise<boolean>;
}

/**
 * 技能目录服务。
 */
export class ChatdshSkillsService extends TypertRemoteService {
  /** 依赖的技能注册表与结构化存储。 */
  static inject = ['skills', 'storageDomain'];

  private catalog: SkillCatalog = createSkillCatalog([]);
  private overrides: Table<SkillOverrideRecord> | undefined;

  constructor(ctx: Context) {
    super(ctx, SERVICE_NAME);
  }

  /** 首次扫描目录：把宿主的技能摘要装进本项目的目录，再加盖已保存的启用决定。 */
  async [TypertRemoteService.init](): Promise<void> {
    const domain = await storageDomainOf(this.ctx).open(SKILLS_DOMAIN);
    this.overrides = domain.table('overrides') as unknown as Table<SkillOverrideRecord>;
    const summaries = await skillsOf(this.ctx).list();
    const catalog = createSkillCatalog(summaries.map((summary) => ({
      id: summary.name,
      name: summary.name,
      description: summary.description,
      source: sourceKindOf(summary.source),
    })));
    catalog.applyOverrides(this.persistedOverrides());
    this.catalog = catalog;
  }

  /** 列出全部技能，带启用状态。 */
  @Remote('list')
  list(): SkillEntry[] {
    return this.catalog.list();
  }

  /** 数量统计。 */
  @Remote('catalog')
  catalogState(): SkillCatalogState {
    return this.catalog.catalog();
  }

  /** 显式启用决定。 */
  @Remote('overrides')
  overrideList(): SkillOverride[] {
    return this.catalog.overrides();
  }

  /**
   * 按关键字与来源检索技能。
   * @param request - 检索请求。
   * @returns 命中的技能，带启用状态。
   */
  @Remote('search')
  async search(request: SkillSearchRequest = {}): Promise<SkillEntry[]> {
    const telemetry = this.telemetry();
    const run = async (span?: SpanLike): Promise<SkillEntry[]> => {
      try {
        const hits = this.catalog.search(request);
        span?.setAttribute('hits', hits.length);
        span?.setAttribute('outcome', 'ok');
        telemetry?.counter('chatdsh_skill_searches_total', { description: '技能检索结果' }).add(1, { outcome: 'ok' });
        return hits;
      } catch (error) {
        const type = error instanceof Error ? error.name : 'Unknown';
        const code = errorCodeOf(error);
        span?.setAttribute('hits', 0);
        span?.setAttribute('outcome', 'failed');
        span?.setAttribute('error.type', type);
        telemetry?.event('chatdsh.runtime.skill.rejected', {
          action: 'search',
          outcome: 'failed',
          'error.type': type,
          'error.code': code,
        });
        telemetry?.counter('chatdsh_skill_searches_total', { description: '技能检索结果' }).add(1, { outcome: 'failed' });
        throw error;
      }
    };
    if (telemetry === undefined) return run();
    return telemetry.runSpan('chatdsh.runtime.skill.search', { source: request.source ?? 'all' }, run);
  }

  /**
   * 设置一个技能的启用状态并落盘。
   *
   * 先写存储再改内存：写失败时目录状态保持不变。存储里只记录显式决定，重启后重新
   * 扫描技能目录再叠加这些决定。
   * @param id - 技能标识。
   * @param enabled - 目标状态。
   * @returns 设置后的状态。
   */
  @Remote('toggle')
  async toggle(id: string, enabled: boolean): Promise<{ id: string; enabled: boolean }> {
    const telemetry = this.telemetry();
    const run = async (span?: SpanLike): Promise<{ id: string; enabled: boolean }> => {
      try {
        if (typeof enabled !== 'boolean') throw new ChatdshError('request-invalid', '启用状态必须是布尔值');
        if (!this.catalog.has(id)) throw new ChatdshError('object-not-found', `未知技能：${id}`);
        await this.require().put(id, { id, enabled, updatedAt: Date.now() });
        const result = this.catalog.toggle(id, enabled);
        span?.setAttribute('outcome', 'ok');
        telemetry?.counter('chatdsh_skill_toggles_total', { description: '技能启用状态切换次数' }).add(1, { enabled, outcome: 'ok' });
        return result;
      } catch (error) {
        const type = error instanceof Error ? error.name : 'Unknown';
        const code = errorCodeOf(error);
        span?.setAttribute('outcome', 'failed');
        span?.setAttribute('error.type', type);
        telemetry?.event('chatdsh.runtime.skill.rejected', {
          action: 'toggle',
          outcome: 'failed',
          'error.type': type,
          'error.code': code,
        });
        telemetry?.counter('chatdsh_skill_toggles_total', { description: '技能启用状态切换次数' }).add(1, { enabled, outcome: 'failed' });
        throw error;
      }
    };
    if (telemetry === undefined) return run();
    return telemetry.runSpan('chatdsh.runtime.skill.toggle', { 'skill.id': id, enabled }, run);
  }

  /** 取遥测服务；没有安装遥测插件时为 undefined。 */
  private telemetry(): SkillsTelemetry | undefined {
    return telemetryOf<SkillsTelemetry>(this.ctx);
  }

  /** 已保存的启用决定。 */
  private persistedOverrides(): SkillOverride[] {
    return [...this.require().entries()].map(([, record]) => ({ id: record.id, enabled: record.enabled }));
  }

  private require(): Table<SkillOverrideRecord> {
    if (this.overrides === undefined) throw new Error('技能存储还没有打开');
    return this.overrides;
  }
}

/** 取错误码；非契约异常按内部故障归类。 */
function errorCodeOf(error: unknown): ChatdshErrorCode {
  if (error instanceof ChatdshError) return error.code;
  return 'internal-error';
}

/** 注册技能目录服务。 */
export function apply(ctx: Context): void {
  ctx.plugin(ChatdshSkillsService);
}
