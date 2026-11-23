/**
 * 对话顶部的远程执行状态条。
 * @module @chatdsh/client-remote/status-bar
 */

import { useEffect, type ReactNode } from 'react';
import type { RemoteController } from './controller.ts';
import type { OverviewDevice } from './model.ts';
import { parseDevicePath } from './state.ts';
import { useRemoteController } from './use-controller.ts';

/** 状态条的展示属性。 */
export interface StatusStripProps {
  readonly t: ChatdshRemoteTranslate;
  readonly deviceId: string;
  readonly device: OverviewDevice | undefined;
}

/**
 * 状态条的展示部分。
 * @param props - 当前设备与翻译函数。
 * @returns 状态条。
 */
export function StatusStrip({ t, deviceId, device }: StatusStripProps): ReactNode {
  const name = device?.name ?? deviceId;
  return (
    <div className="chatdsh-remote-statusbar">
      <span className="chatdsh-remote-dot" data-online={device?.online === true} />
      <span>{t('status.current', { name })}</span>
      <a className="chatdsh-remote-link" href="/">{t('status.return')}</a>
    </div>
  );
}

/** 状态条的注册组件属性。 */
export interface RemoteStatusBarProps {
  readonly t: ChatdshRemoteTranslate;
  readonly controller: RemoteController;
}

/**
 * 只在 `/d/<deviceId>/` 页面渲染的状态条。
 * @param props - 控制器与翻译函数。
 * @returns 状态条或空。
 */
export function RemoteStatusBar({ t, controller }: RemoteStatusBarProps): ReactNode {
  const snapshot = useRemoteController(controller);
  useEffect(() => {
    controller.ensureOverview();
  }, [controller]);
  const deviceId = parseDevicePath(location.pathname);
  if (deviceId === undefined) return null;
  const device = snapshot.devices.find((item) => item.id === deviceId);
  return <StatusStrip t={t} deviceId={deviceId} device={device} />;
}
