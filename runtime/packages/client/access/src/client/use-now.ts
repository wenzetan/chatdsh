/**
 * 每秒刷新的当前时刻。
 *
 * 锁定倒计时、验证码时间片与相对时间都用它取当前时刻，组件卸载时清理定时器。
 * @module @chatdsh/client-access/use-now
 */

import { useEffect, useState } from 'react';

/**
 * 订阅每秒更新的当前时刻。
 * @param intervalMs - 刷新间隔，单位毫秒。
 * @returns 当前时刻的毫秒时间戳。
 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const handle = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(handle);
  }, [intervalMs]);
  return now;
}
