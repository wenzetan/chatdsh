/**
 * 技能目录宿主插件。
 *
 * 启动时从 `ctx.skills` 读一次目录（异步发现），按来源映射成本项目的三类；运行期只改
 * 启用状态，不重新扫描。停用只影响本项目的目录视图与 `skill_manage` 工具，不改变上游
 * 提供方自己的注册。
 * @module @chatdsh/host-skills
 */

import { Remote, skillsOf, telemetryOf, TypertRemoteService, type Context } from '@chatdsh/adapter';
import type {} from '@deepseek-ai/dsh-skill';
import { createSkillCatalog, type SkillCatalog, type SkillCatalogState, type SkillEntry, type SkillSourceKind } from './registry.ts';

export { createSkillCatalog } from './registry.ts';
export type { SkillCatalog, SkillCatalogState, SkillEntry, SkillSourceKind } from './registry.ts';

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

/** 用到的遥测面。 */
interface SkillsTelemetry {
  runSpanSync<T>(name: string, attributes: Record<string, unknown>, body: (span: { setAttribute(key: string, value: unknown): void }) => T): T;
  counter(name: string, options?: { description: string }): { add(delta: number, attributes?: Record<string, unknown>): void };
}

/**
 * 技能目录服务。
 */
export class ChatdshSkillsService extends TypertRemoteService {
  /** 依赖的技能注册表。 */
  static inject = ['skills'];

  private catalog: SkillCatalog = createSkillCatalog([]);

  constructor(ctx: Context) {
    super(ctx, SERVICE_NAME);
  }

  /** 首次扫描目录：把宿主的技能摘要装进本项目的目录。 */
  async [TypertRemoteService.init](): Promise<void> {
    const summaries = await skillsOf(this.ctx).list();
    this.catalog = createSkillCatalog(summaries.map((summary) => ({
      id: summary.name,
      name: summary.name,
      description: summary.description,
      source: sourceKindOf(summary.source),
    })));
  }

  /** 列出全部技能。 */
  @Remote('list')
  list(): SkillEntry[] {
    return this.catalog.list();
  }

  /** 数量统计。 */
  @Remote('catalog')
  catalogState(): SkillCatalogState {
    return this.catalog.catalog();
  }

  /** 设置一个技能的启用状态。 */
  @Remote('toggle')
  toggle(id: string, enabled: boolean): { id: string; enabled: boolean } {
    const telemetry = telemetryOf<SkillsTelemetry>(this.ctx);
    if (telemetry === undefined) return this.catalog.toggle(id, enabled);
    return telemetry.runSpanSync('chatdsh.runtime.skill.toggle', { 'skill.id': id, enabled }, (span) => {
      try {
        const result = this.catalog.toggle(id, enabled);
        span.setAttribute('outcome', 'ok');
        telemetry.counter('chatdsh_skill_toggles_total', { description: '技能启用状态切换次数' })
          .add(1, { enabled, outcome: 'ok' });
        return result;
      } catch (error) {
        span.setAttribute('outcome', 'failed');
        span.setAttribute('error.type', error instanceof Error ? error.name : 'Unknown');
        telemetry.counter('chatdsh_skill_toggles_total', { description: '技能启用状态切换次数' })
          .add(1, { enabled, outcome: 'failed' });
        throw error;
      }
    });
  }
}

/** 注册技能目录服务。 */
export function apply(ctx: Context): void {
  ctx.plugin(ChatdshSkillsService);
}
