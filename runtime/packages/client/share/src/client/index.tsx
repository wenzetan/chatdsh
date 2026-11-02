/**
 * 分享面板：创建分享、管理分享记录与导入会话副本。
 *
 * 全部数据来自控制平面的真实接口：会话聚合、副本读取、分享预览、分享记录、建立与撤销、
 * 公开页探测与导入。面板在控制平面入口不可达时显示明确失败，不渲染成空列表。分享区段落
 * 在设置页席位 `settings.section` 上，与其它业务面板共用同一套槽位约定。
 * @module @chatdsh/client-share
 */

import { Tabs } from '@chatdsh/core-ui-kit';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CreateSharePanel } from './create.tsx';
import { createShareGateway } from './gateway.ts';
import { ImportPanel } from './imports.tsx';
import type { Loadable } from './loadable.ts';
import { ShareRecordsPanel } from './records.tsx';
import { browserTelemetry } from './telemetry.ts';
import type { SessionsSnapshot, ShareGateway, ShareList } from './types.ts';

/** 席位名。 */
export const SECTION_SLOT = 'settings.section';

/** 区段标识。 */
export const SECTION_ID = 'chatdsh-share';

/** 浏览器侧依赖：只等席位服务，模块加载顺序由模块图自己保证。 */
export const inject = ['slots'];

/** 分区。 */
const TABS = [
  { id: 'create', label: '创建分享' },
  { id: 'records', label: '分享记录' },
  { id: 'import', label: '导入会话' },
] as const;

/** 面板属性；测试与嵌入场景可以直接传数据入口。 */
export interface ShareSectionProps {
  readonly gateway?: ShareGateway;
}

let sharedGateway: ShareGateway | undefined;

/**
 * 取数据入口。
 * @param provided - 调用方传入的入口。
 * @returns 数据入口。
 */
function gatewayOf(provided?: ShareGateway): ShareGateway {
  if (provided !== undefined) return provided;
  sharedGateway ??= createShareGateway({ telemetry: browserTelemetry });
  return sharedGateway;
}

/**
 * 设置页区段：分享的完整界面。
 * @param props - 可选的数据入口。
 * @returns 区段内容。
 */
export function ShareSection({ gateway }: ShareSectionProps = {}) {
  const face = gatewayOf(gateway);
  const [tab, setTab] = useState<string>('create');
  const [sessions, setSessions] = useState<Loadable<SessionsSnapshot>>({ status: 'loading' });
  const [shares, setShares] = useState<Loadable<ShareList>>({ status: 'loading' });
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const loadSessions = useCallback((): void => {
    setSessions({ status: 'loading' });
    face.sessions().then(
      (value) => {
        if (alive.current) setSessions({ status: 'ready', value });
      },
      (error: unknown) => {
        if (alive.current) setSessions({ status: 'failed', error });
      },
    );
  }, [face]);

  const loadShares = useCallback((): void => {
    setShares({ status: 'loading' });
    face.shares().then(
      (value) => {
        if (!alive.current) return;
        setShares({ status: 'ready', value });
        face.noteAction('share-reload', 'ok');
      },
      (error: unknown) => {
        if (alive.current) setShares({ status: 'failed', error });
        face.noteAction('share-reload', 'failed');
      },
    );
  }, [face]);

  useEffect(() => {
    loadSessions();
    loadShares();
  }, [loadSessions, loadShares]);

  return (
    <Tabs
      label="分享"
      selectedId={tab}
      onSelect={(next) => {
        setTab(next);
        // 打开记录时重新读取：访问次数与状态在建立、撤销与访问之后都会变。
        if (next === 'records') loadShares();
      }}
      items={TABS.map((item) => ({
        id: item.id,
        label: item.label,
        content: item.id === 'create'
          ? <CreateSharePanel gateway={face} sessions={sessions} onCreated={loadShares} />
          : item.id === 'records'
            ? <ShareRecordsPanel gateway={face} shares={shares} onReload={loadShares} />
            : <ImportPanel gateway={face} sessions={sessions} />,
      }))}
    />
  );
}

/**
 * 注册设置页区段。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: { slots: ClientSlots }): void {
  ctx.slots.inject(SECTION_SLOT, () => ctx.slots.register({
    name: SECTION_SLOT,
    id: SECTION_ID,
    order: 50,
    label: () => '分享',
    locale: 'chatdsh.share',
  }, ShareSection));
}

/** 席位服务的最小形状。 */
interface ClientSlots {
  inject(key: string, callback: () => () => void): () => void;
  register(spec: { name: string; id?: string; order?: number; label?: () => string; locale?: string }, Component: () => unknown): () => void;
}
