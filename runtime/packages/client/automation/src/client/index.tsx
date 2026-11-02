/**
 * 自动化面板：列表、新建与编辑、投递记录、原会话定时任务。
 *
 * 全部数据来自控制平面的真实接口与执行设备上的真实运行时：自动化记录、投递记录、执行节点、
 * 按设备分组的会话，以及经 `/d/<deviceId>/` 前缀送到原会话运行时的定时任务。控制平面没有
 * 提供的操作按失败显示原因，不渲染成空列表，也不在页面里假装成功。
 *
 * 面板落在设置页席位 `settings.section` 上，与其它业务面板共用同一套槽位约定。
 * @module @chatdsh/client-automation
 */

import { StatusLine, Tabs } from '@chatdsh/core-ui-kit';
import { useCallback, useEffect, useState } from 'react';
import { DeliveryPanel } from './deliveries.tsx';
import { AutomationEditor } from './editor.tsx';
import { createAutomationGateway } from './gateway.ts';
import { AutomationListPanel } from './list.tsx';
import { SchedulePanel } from './schedules.tsx';
import { browserTelemetry } from './telemetry.ts';
import type { Loadable } from './loadable.ts';
import type { AutomationGateway, AutomationRecord, DeviceSummary, SessionsSnapshot } from './types.ts';

export { AUTOMATIONS_PATH, CSRF_HEADER, DELIVERIES_PATH, DEVICES_PATH, SESSIONS_PATH } from './gateway.ts';

/** 席位名，与宿主侧入口共用同一个约定。 */
export const SECTION_SLOT = 'settings.section';

/** 区段标识。 */
export const SECTION_ID = 'chatdsh-automation';

/** 浏览器侧依赖：只等席位服务。 */
export const inject = ['slots'];

/** 分区。 */
const TABS = [
  { id: 'list', label: '自动化列表' },
  { id: 'editor', label: '新建与编辑' },
  { id: 'deliveries', label: '投递记录' },
  { id: 'schedules', label: '原会话定时任务' },
] as const;

/** 面板属性；测试与嵌入场景可以直接传数据入口。 */
export interface AutomationSectionProps {
  /** 数据入口。 */
  readonly gateway?: AutomationGateway;
  /** 打开时选中的分区。 */
  readonly initialTab?: string;
}

let sharedGateway: AutomationGateway | undefined;

/**
 * 取数据入口。
 * @param provided - 调用方传入的入口。
 * @returns 数据入口。
 */
function gatewayOf(provided?: AutomationGateway): AutomationGateway {
  if (provided !== undefined) return provided;
  sharedGateway ??= createAutomationGateway({ telemetry: browserTelemetry });
  return sharedGateway;
}

/**
 * 设置页区段：自动化的完整界面。
 * @param props - 可选的数据入口与初始分区。
 * @returns 区段内容。
 */
export function AutomationSection({ gateway, initialTab = 'list' }: AutomationSectionProps = {}) {
  const face = gatewayOf(gateway);
  const [tab, setTab] = useState<string>(initialTab);
  const [automations, setAutomations] = useState<Loadable<readonly AutomationRecord[]>>({ status: 'loading' });
  const [devices, setDevices] = useState<Loadable<readonly DeviceSummary[]>>({ status: 'loading' });
  const [sessions, setSessions] = useState<Loadable<SessionsSnapshot>>({ status: 'loading' });
  const [editing, setEditing] = useState<AutomationRecord | undefined>(undefined);
  const [editorKey, setEditorKey] = useState(0);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  const loadAutomations = useCallback((): void => {
    setAutomations({ status: 'loading' });
    face.automations().then(
      (value) => {
        setAutomations({ status: 'ready', value });
        face.noteAction('automation-reload', 'ok');
      },
      (error: unknown) => {
        setAutomations({ status: 'failed', error });
        face.noteAction('automation-reload', 'failed');
      },
    );
  }, [face]);

  const loadDevices = useCallback((): void => {
    setDevices({ status: 'loading' });
    face.devices().then(
      (value) => setDevices({ status: 'ready', value }),
      (error: unknown) => setDevices({ status: 'failed', error }),
    );
  }, [face]);

  const loadSessions = useCallback((): void => {
    setSessions({ status: 'loading' });
    face.sessions().then(
      (value) => setSessions({ status: 'ready', value }),
      (error: unknown) => setSessions({ status: 'failed', error }),
    );
  }, [face]);

  useEffect(() => {
    loadAutomations();
    loadDevices();
    loadSessions();
  }, [loadAutomations, loadDevices, loadSessions]);

  const openEditor = (record?: AutomationRecord): void => {
    setEditing(record);
    setEditorKey((current) => current + 1);
    setNotice(undefined);
    setTab('editor');
  };

  const listRecords = automations.status === 'ready' ? automations.value : [];

  return (
    <div data-automation-section>
      <Tabs
        label="自动化面板分区"
        selectedId={tab}
        onSelect={setTab}
        items={TABS.map((item) => ({
          id: item.id,
          label: item.label,
          content: item.id === 'list' ? (
            <AutomationListPanel
              gateway={face}
              automations={automations}
              onReload={loadAutomations}
              onCreate={() => openEditor(undefined)}
              onEdit={(record) => openEditor(record)}
              onChanged={(record) => {
                setAutomations((current) => current.status === 'ready'
                  ? { status: 'ready', value: current.value.map((entry) => (entry.id === record.id ? record : entry)) }
                  : current);
              }}
            />
          ) : item.id === 'editor' ? (
            <AutomationEditor
              key={editorKey}
              gateway={face}
              editing={editing}
              devices={devices}
              onDevicesReload={loadDevices}
              onCancel={() => setTab('list')}
              onSaved={(record, created) => {
                setNotice(created ? `已创建自动化「${record.name}」。` : `已保存自动化「${record.name}」。`);
                setTab('list');
                loadAutomations();
              }}
            />
          ) : item.id === 'deliveries' ? (
            <DeliveryPanel gateway={face} automations={listRecords} active={tab === 'deliveries'} />
          ) : (
            <SchedulePanel
              gateway={face}
              devices={devices}
              sessions={sessions}
              onDevicesReload={loadDevices}
              onSessionsReload={loadSessions}
            />
          ),
        }))}
      />
      {notice === undefined ? null : <StatusLine>{notice}</StatusLine>}
    </div>
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
    order: 48,
    label: () => '自动化',
    locale: 'chatdsh.automation',
  }, AutomationSection));
}

/** 席位服务的最小形状。 */
interface ClientSlots {
  inject(key: string, callback: () => void): () => void;
  register(spec: { name: string; id?: string; order?: number; label?: () => string; locale?: string }, Component: () => unknown): () => void;
}
