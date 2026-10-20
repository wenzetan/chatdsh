/**
 * 账号面板：展示当前账号与已登记的设备。
 *
 * 账号与设备属于控制平面，面板按同源相对路径访问它的接口。直连运行时的页面拿不到这些
 * 记录，面板会说明当前形态不支持。
 * @module @chatdsh/client-account
 */

import { useEffect, useState } from 'react';

/** 一条设备记录。 */
interface DeviceRecord {
  readonly id: string;
  readonly accountId: string;
  readonly origin: string;
  readonly platform?: string;
  readonly lastSeenAt: number;
}

/** 控制平面的设备接口。 */
export const DEVICES_PATH = '/chatdsh/gateway/devices';

/** 席位名。 */
export const SECTION_SLOT = 'settings.section';

/** 区段标识。 */
export const SECTION_ID = 'chatdsh-account';

/** 浏览器侧依赖：只等席位服务，模块加载顺序由模块图自己保证。 */
export const inject = ['slots'];

/** 读取设备列表。 */
async function loadDevices(): Promise<DeviceRecord[]> {
  const response = await fetch(DEVICES_PATH, { headers: { 'x-chatdsh-account': 'list' } });
  if (!response.ok) throw new Error(`设备列表返回 ${response.status}`);
  const payload = (await response.json()) as { devices?: DeviceRecord[] };
  return payload.devices ?? [];
}

/** 设置页区段。 */
function AccountSection() {
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

  if (failed) return <p style={{ fontSize: 13, opacity: 0.7 }}>账号信息暂不可用：这条页面没有经过控制平面。</p>;
  if (devices === undefined) return <p style={{ fontSize: 13, opacity: 0.7 }}>正在读取设备…</p>;
  if (devices.length === 0) return <p style={{ fontSize: 13, opacity: 0.7 }}>还没有登记的设备。</p>;

  return (
    <div style={{ fontSize: 13 }}>
      <p style={{ margin: '0 0 8px', fontWeight: 600 }}>共 {devices.length} 台设备</p>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {devices.map((device) => (
          <li key={device.id} style={{ padding: '8px 0', borderBottom: '1px solid rgba(0,0,0,0.08)' }}>
            <div style={{ fontWeight: 600 }}>{device.platform ?? '未知平台'}</div>
            <div style={{ opacity: 0.7 }}>
              {device.origin} · 最近在线 {new Date(device.lastSeenAt).toISOString()}
            </div>
          </li>
        ))}
      </ul>
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
    order: 55,
    label: () => '账号',
    locale: 'chatdsh.account',
  }, AccountSection));
}

/** 席位服务的最小形状。 */
interface ClientSlots {
  inject(key: string, callback: () => () => void): () => void;
  register(spec: { name: string; id?: string; order?: number; label?: () => string; locale?: string }, Component: () => unknown): () => void;
}
