/**
 * 设备面板：展示已登记的执行节点与在线状态。
 *
 * 设备属于控制平面，面板按同源相对路径访问它的接口。直连运行时的页面拿不到这些记录，
 * 面板会说明当前形态不支持。
 * @module @chatdsh/client-account
 */

import { useEffect, useState } from 'react';
import { EmptyState, List, Panel, Row, Skeleton, StatusLine } from '@chatdsh/core-ui-kit';

/** 一条设备记录：控制平面登记的执行节点。 */
interface DeviceRecord {
  readonly id: string;
  readonly name: string;
  readonly platform: string;
  readonly role: 'host' | 'executor' | 'both';
  readonly capabilities: readonly string[];
  /** 在线状态由控制平面的长连接表判定。 */
  readonly online: boolean;
  readonly lastSeenAt: number;
}

/** 角色的中文名。 */
const ROLE_LABELS: Record<DeviceRecord['role'], string> = {
  host: '宿主',
  executor: '执行节点',
  both: '宿主与执行节点',
};

/** 控制平面的设备接口。 */
export const DEVICES_PATH = '/chatdsh/gateway/devices';

/** 席位名。 */
export const SECTION_SLOT = 'settings.section';

/** 区段标识。 */
export const SECTION_ID = 'chatdsh-devices';

/** 浏览器侧依赖：只等席位服务，模块加载顺序由模块图自己保证。 */
export const inject = ['slots'];

/** 读取设备列表。 */
async function loadDevices(): Promise<DeviceRecord[]> {
  const response = await fetch(DEVICES_PATH);
  if (!response.ok) throw new Error(`设备列表返回 ${response.status}`);
  const payload = (await response.json()) as { devices?: DeviceRecord[] };
  return payload.devices ?? [];
}

/** 设置页区段：设备列表，覆盖加载、空、失败三类状态。 */
export function DeviceSection() {
  const [devices, setDevices] = useState<DeviceRecord[] | undefined>(undefined);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadDevices().then(
      (records) => {
        if (!cancelled) setDevices(records);
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (failed) return <Panel title="设备"><StatusLine tone="danger">设备信息暂不可用：这条页面没有经过控制平面。</StatusLine></Panel>;
  if (devices === undefined) return <Panel title="设备"><Skeleton rows={2} /></Panel>;
  if (devices.length === 0) return <Panel title="设备"><EmptyState>还没有登记的设备。</EmptyState></Panel>;
  return (
    <Panel title="设备" count={`${devices.length}`}>
      <List>
        {devices.map((device) => (
          <Row
            key={device.id}
            dot={device.online ? 'ok' : 'idle'}
            title={device.name}
            meta={`${device.platform} · ${ROLE_LABELS[device.role]} · ${device.online ? '在线' : '离线'} · 最近在线 ${new Date(device.lastSeenAt).toISOString()}`}
          />
        ))}
      </List>
    </Panel>
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
    order: 55,
    label: () => '设备',
    locale: 'chatdsh.devices',
  }, DeviceSection));
}

/** 席位服务的最小形状。 */
interface ClientSlots {
  inject(key: string, callback: () => () => void): () => void;
  register(spec: { name: string; id?: string; order?: number; label?: () => string; locale?: string }, Component: () => unknown): () => void;
}
