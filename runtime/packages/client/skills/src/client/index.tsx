/**
 * 技能面板：把技能目录与启用状态列在设置页里。
 *
 * 数据经 Remote 调用取得（服务名 `chatdshSkills`）。停用动作走同一个服务的 `toggle`，
 * 失败时就地给出提示，不改本地列表。
 * @module @chatdsh/client-skills
 */

import { useEffect, useState } from 'react';

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
export const inject = ['slots'];

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
export function apply(ctx: ClientFace & { slots: ClientSlots }): void {
  clientFace = ctx;
  ctx.slots.inject(SECTION_SLOT, () => ctx.slots.register({
    name: SECTION_SLOT,
    id: SECTION_ID,
    order: 47,
    label: () => '技能',
    locale: 'chatdsh.skills',
  }, SkillsSection));
}

/** 设置页区段。 */
function SkillsSection() {
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
      ([records, size]) => {
        if (cancelled) return;
        setSkills(records);
        setState(size);
      },
      () => {
        if (!cancelled) setError(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <p style={{ fontSize: 13, opacity: 0.7 }}>技能目录暂不可用。</p>;
  if (skills === undefined || state === undefined) return <p style={{ fontSize: 13, opacity: 0.7 }}>正在读取技能…</p>;

  return (
    <div style={{ fontSize: 13 }}>
      <p style={{ margin: '0 0 8px', opacity: 0.7 }}>{formatSkillSummary(state)}</p>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {skills.map((record) => (
          <li key={record.id} style={{ padding: '6px 0', borderBottom: '1px solid rgba(0,0,0,0.08)' }}>
            <div style={{ fontWeight: 600 }}>{record.name}</div>
            <div style={{ opacity: 0.7 }}>{SOURCE_LABEL[record.source]} · {record.description}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 席位服务的最小形状。 */
interface ClientSlots {
  inject(key: string, callback: () => () => void): () => void;
  register(spec: { name: string; id?: string; order?: number; label?: () => string; locale?: string }, Component: () => unknown): () => void;
}
