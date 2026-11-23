/**
 * 让 React 组件订阅控制器快照。
 * @module @chatdsh/client-remote/use-controller
 */

import { useEffect, useState } from 'react';
import type { RemoteController } from './controller.ts';
import type { RemoteSnapshot } from './types.ts';

/**
 * 订阅控制器并返回当前快照。
 * @param controller - 远程设备控制器。
 * @returns 当前快照。
 */
export function useRemoteController(controller: RemoteController): RemoteSnapshot {
  const [snapshot, setSnapshot] = useState(() => controller.getSnapshot());
  useEffect(() => {
    const update = (): void => setSnapshot(controller.getSnapshot());
    update();
    return controller.subscribe(update);
  }, [controller]);
  return snapshot;
}
