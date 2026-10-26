import { buildRemoteContribution, unwrapRemoteResult } from '@chatdsh/core-remote-client';
import { z } from 'zod';
/**
 * 技能面板：把技能目录与启用状态列在设置页里。
 *
 * 数据经 Remote 调用取得（服务名 `chatdshSkills`）。停用动作走同一个服务的 `toggle`，
 * 失败时就地给出提示，不改本地列表。
 * @module @chatdsh/client-skills
 */

import { useEffect, useState } from 'react';
import { Badge, EmptyState, List, Panel, Row, Skeleton, StatusLine } from '@chatdsh/core-ui-kit';

/** 一条技能。 */
interface SkillRecord {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly source: 'builtin' | 'workspace' | 'user';
}

/** 数量统计。 */
interface SkillCatalogState {
  readonly total: number;
  readonly enabled: number;
}

/** 浏览器侧上下文的可用面。 */
interface ClientFace {
  readonly remote?: {
    readonly chatdshSkills?: {
      list?: () => Promise<SkillRecord[]>;
      catalog?: () => Promise<SkillCatalogState>;
      toggle?: (id: string, enabled: boolean) => Promise<{ id: string; enabled: boolean }>;
    };
  };
}

/** 席位名。 */
export const SECTION_SLOT = 'settings.section';

/** 区段标识。 */
export const SECTION_ID = 'chatdsh-skills';

/** 浏览器侧依赖：只等席位服务。 */
export const inject = ['slots', 'remote'];

/** 来源的中文名。 */
const SOURCE_LABEL: Readonly<Record<SkillRecord['source'], string>> = {
  builtin: '内置',
  workspace: '工作区',
  user: '用户',
};

let clientFace: ClientFace | undefined;

/**
 * 面板上的一行统计。
 * @param state - 数量统计。
 * @returns 面向用户的一句话。
 */
export function formatSkillSummary(state: SkillCatalogState): string {
  if (state.total === 0) return '还没有技能';
  return `${state.total} 个技能，已启用 ${state.enabled} 个`;
}

/**
 * 注册设置页区段。
 * @param ctx - 客户端根上下文。
 */
export async function apply(ctx: ClientFace & { slots: ClientSlots }): Promise<void> {
  clientFace = ctx;
  const remoteHost = ctx as unknown as {
    remote: { $mount(contribution: unknown): Promise<unknown> };
    inject(keys: string[], callback: (scope: ClientFace) => void): unknown;
  };
  await remoteHost.remote.$mount(buildRemoteContribution('chatdshSkills', {
    'chatdshSkills/list': { parameters: [] },
    'chatdshSkills/catalog': { parameters: [] },
    'chatdshSkills/toggle': { parameters: [{ name: 'id', kind: 'string' }, { name: 'enabled', kind: 'boolean' }] },
  }, z));
  await new Promise<void>((resolve) => {
    remoteHost.inject(['remote.chatdshSkills'], (scope) => {
      clientFace = scope;
      resolve();
    });
  });

  ctx.slots.inject(SECTION_SLOT, () => ctx.slots.register({
    name: SECTION_SLOT,
    id: SECTION_ID,
    order: 47,
    label: () => '技能',
    locale: 'chatdsh.skills',
  }, SkillsSection));
}

/** 设置页区段：技能列表，覆盖加载、空、失败三类状态。 */
export function SkillsSection() {
  const [skills, setSkills] = useState<SkillRecord[] | undefined>(undefined);
  const [state, setState] = useState<SkillCatalogState | undefined>(undefined);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const list = clientFace?.remote?.chatdshSkills?.list;
    const catalog = clientFace?.remote?.chatdshSkills?.catalog;
    if (list === undefined || catalog === undefined) {
      setError(true);
      return;
    }
    Promise.all([list.call(clientFace?.remote?.chatdshSkills), catalog.call(clientFace?.remote?.chatdshSkills)]).then(
      ([recordsResult, sizeResult]) => {
        if (cancelled) return;
        setSkills(unwrapRemoteResult(recordsResult));
        setState(unwrapRemoteResult(sizeResult));
      },
      () => {
        if (!cancelled) setError(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <Panel title="技能"><StatusLine tone="danger">技能目录暂不可用。</StatusLine></Panel>;
  if (skills === undefined || state === undefined) return <Panel title="技能"><Skeleton rows={3} /></Panel>;
  if (skills.length === 0) return <Panel title="技能"><EmptyState>{formatSkillSummary(state)}</EmptyState></Panel>;
  return (
    <Panel title="技能" subtitle={formatSkillSummary(state)} count={`${skills.length}`}>
      <List>
        {skills.map((record) => (
          <Row key={record.id} title={record.name} badge={<Badge tone="neutral">{SOURCE_LABEL[record.source]}</Badge>} meta={record.description} />
        ))}
      </List>
    </Panel>
  );
}

/** 席位服务的最小形状。 */
interface ClientSlots {
  inject(key: string, callback: () => () => void): () => void;
  register(spec: { name: string; id?: string; order?: number; label?: () => string; locale?: string }, Component: () => unknown): () => void;
}
