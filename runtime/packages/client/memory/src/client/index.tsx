import { buildRemoteContribution } from '@chatdsh/core-remote-client';
import { Tabs } from '@chatdsh/core-ui-kit';
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
/**
 * 记忆面板：服务状态、检索与条目管理、记忆组与未确认写入。
 *
 * 数据经 Remote 调用取得（服务名 `chatdshMemory`）。宿主没有注册记忆服务时每个面板都显示
 * 未启用与明确失败，不伪造成功；检索内容只保留在页面内存里。
 * @module @chatdsh/client-memory
 */

import {
  callRemote,
  failureOf,
  type Loadable,
  type MemoryGroupView,
  type MemoryRemoteFace,
  type MemorySettingsView,
  type MemoryWriteQueueView,
} from './face.ts';
import { GroupsPanel } from './groups-panel.tsx';
import { SearchPanel } from './search-panel.tsx';
import { ServicePanel } from './service-panel.tsx';
import { WritesPanel } from './writes-panel.tsx';

/** 席位名。 */
export const SECTION_SLOT = 'settings.section';

/** 区段标识。 */
export const SECTION_ID = 'chatdsh-memory';

/** 浏览器侧依赖：只等席位服务，模块加载顺序由模块图自己保证。 */
export const inject = ['slots', 'remote'];

/** 浏览器侧上下文的可用面。 */
interface ClientFace {
  readonly remote?: { readonly chatdshMemory?: MemoryRemoteFace };
}

/** 页面里的四个分页。 */
const TABS = [
  { id: 'service', label: '记忆服务' },
  { id: 'search', label: '检索与条目' },
  { id: 'groups', label: '记忆组' },
  { id: 'writes', label: '未确认写入' },
] as const;

let clientFace: MemoryRemoteFace | undefined;

/** 面板属性；测试与嵌入场景可以直接传服务面。 */
export interface MemorySectionProps {
  readonly remote?: MemoryRemoteFace;
}

/**
 * 设置页区段：记忆的完整界面。
 * @param props - 可选的记忆服务面。
 * @returns 区段内容。
 */
export function MemorySection({ remote }: MemorySectionProps = {}) {
  const face = remote ?? clientFace;
  const [tab, setTab] = useState<string>('service');
  const [settings, setSettings] = useState<Loadable<MemorySettingsView>>({ status: 'loading' });
  const [groups, setGroups] = useState<Loadable<readonly MemoryGroupView[]>>({ status: 'loading' });
  const [queue, setQueue] = useState<Loadable<MemoryWriteQueueView>>({ status: 'loading' });
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const loadSettings = useCallback(async (): Promise<void> => {
    if (face?.settings === undefined) {
      if (alive.current) setSettings({ status: 'unavailable' });
      return;
    }
    try {
      const value = await callRemote<MemorySettingsView>('读取记忆配置', () => face.settings!());
      if (alive.current) setSettings({ status: 'ready', value });
    } catch (error) {
      if (alive.current) setSettings({ status: 'failed', failure: failureOf(error) });
    }
  }, [face]);

  const loadGroups = useCallback(async (): Promise<readonly MemoryGroupView[] | undefined> => {
    if (face?.listGroups === undefined) {
      if (alive.current) setGroups({ status: 'unavailable' });
      return undefined;
    }
    try {
      const value = await callRemote<readonly MemoryGroupView[]>('读取记忆组', () => face.listGroups!());
      if (alive.current) setGroups({ status: 'ready', value });
      return value;
    } catch (error) {
      if (alive.current) setGroups({ status: 'failed', failure: failureOf(error) });
      return undefined;
    }
  }, [face]);

  const loadQueue = useCallback(async (): Promise<void> => {
    if (face?.writeQueue === undefined) {
      if (alive.current) setQueue({ status: 'unavailable' });
      return;
    }
    try {
      const value = await callRemote<MemoryWriteQueueView>('读取未确认写入', () => face.writeQueue!());
      if (alive.current) setQueue({ status: 'ready', value });
    } catch (error) {
      if (alive.current) setQueue({ status: 'failed', failure: failureOf(error) });
    }
  }, [face]);

  useEffect(() => {
    void loadSettings();
    void loadGroups();
    void loadQueue();
  }, [loadSettings, loadGroups, loadQueue]);

  /** 重新读取全部视图。 */
  const reloadAll = useCallback((): void => {
    void loadSettings();
    void loadGroups();
    void loadQueue();
  }, [loadSettings, loadGroups, loadQueue]);

  return (
    <Tabs
      label="记忆"
      selectedId={tab}
      onSelect={setTab}
      items={TABS.map((item) => ({
        id: item.id,
        label: item.label,
        content: item.id === 'service'
          ? <ServicePanel state={settings} onReload={reloadAll} />
          : item.id === 'search'
            ? <SearchPanel face={face} settings={settings} groups={groups} onReload={reloadAll} />
            : item.id === 'groups'
              ? <GroupsPanel face={face} state={groups} onReload={loadGroups} />
              : <WritesPanel face={face} state={queue} onReload={loadQueue} />,
      }))}
    />
  );
}

/**
 * 注册设置页区段。
 * @param ctx - 客户端根上下文。
 */
export async function apply(ctx: ClientFace & { slots: ClientSlots }): Promise<void> {
  clientFace = ctx.remote?.chatdshMemory;
  const remoteHost = ctx as unknown as {
    remote: { $mount(contribution: unknown): Promise<unknown> };
    inject(keys: string[], callback: (scope: ClientFace) => void): unknown;
  };
  await remoteHost.remote.$mount(buildRemoteContribution('chatdshMemory', {
    'chatdshMemory/settings': { parameters: [] },
    'chatdshMemory/search': { parameters: [{ name: 'request', kind: 'json' }] },
    'chatdshMemory/listGroups': { parameters: [] },
    'chatdshMemory/saveGroup': { parameters: [{ name: 'input', kind: 'json' }] },
    'chatdshMemory/detachWorkspace': {
      parameters: [
        { name: 'memoryGroupId', kind: 'string' },
        { name: 'workspace', kind: 'json' },
        { name: 'revision', kind: 'number' },
      ],
    },
    'chatdshMemory/removeGroup': {
      parameters: [{ name: 'memoryGroupId', kind: 'string' }, { name: 'revision', kind: 'number' }],
    },
    'chatdshMemory/writeQueue': { parameters: [] },
    'chatdshMemory/discardWrite': { parameters: [{ name: 'id', kind: 'string' }] },
    'chatdshMemory/updateEntry': {
      parameters: [
        { name: 'bank', kind: 'string' },
        { name: 'source', kind: 'string' },
        { name: 'text', kind: 'string' },
      ],
    },
    'chatdshMemory/deleteEntry': {
      parameters: [{ name: 'bank', kind: 'string' }, { name: 'source', kind: 'string' }],
    },
    'chatdshMemory/deleteEntries': { parameters: [{ name: 'targets', kind: 'json' }] },
  }, z));
  await new Promise<void>((resolve) => {
    remoteHost.inject(['remote.chatdshMemory'], (scope) => {
      clientFace = scope.remote?.chatdshMemory;
      resolve();
    });
  });

  ctx.slots.inject(SECTION_SLOT, () => ctx.slots.register({
    name: SECTION_SLOT,
    id: SECTION_ID,
    order: 60,
    label: () => '记忆',
    locale: 'chatdsh.memory',
  }, MemorySection));
}

/** 席位服务的最小形状。 */
interface ClientSlots {
  inject(key: string, callback: () => () => void): () => void;
  register(spec: { name: string; id?: string; order?: number; label?: () => string; locale?: string }, Component: () => unknown): () => void;
}
