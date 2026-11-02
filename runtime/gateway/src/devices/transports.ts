/**
 * 设备名下的活动通道登记。
 *
 * HTTP 请求、WebSocket 连接与 SSE 流在建立时登记到设备名下，撤销设备时按登记顺序关闭。
 * 在线状态由长连接表回答，这里只回答「这台设备现在还挂着哪些可以立刻掐断的通道」。
 * @module @chatdsh/gateway/devices/transports
 */

/** 通道种类。 */
export type DeviceTransportKind = 'http' | 'websocket' | 'sse';

/** 一次关闭的结果。 */
export interface DeviceTransportCloseResult {
  /** 关闭的通道总数。 */
  readonly closed: number;
  /** 按种类统计的关闭数量。 */
  readonly http: number;
  readonly websocket: number;
  readonly sse: number;
}

/** 一条通道的登记项。 */
interface TransportEntry {
  readonly kind: DeviceTransportKind;
  readonly close: () => void;
}

/** 一台设备当前的通道数量。 */
export interface DeviceTransportCounts {
  readonly total: number;
  readonly http: number;
  readonly websocket: number;
  readonly sse: number;
}

/** 设备名下的通道登记表。 */
export class DeviceTransportRegistry {
  private readonly entries = new Map<string, Set<TransportEntry>>();

  /**
   * 登记一条通道。
   * @param deviceId - 设备标识。
   * @param kind - 通道种类。
   * @param close - 立即关闭这条通道的函数。
   * @returns 释放登记的函数；重复调用只生效一次。
   */
  track(deviceId: string, kind: DeviceTransportKind, close: () => void): () => void {
    const entry: TransportEntry = { kind, close };
    const set = this.entries.get(deviceId) ?? new Set<TransportEntry>();
    set.add(entry);
    this.entries.set(deviceId, set);
    return () => {
      const current = this.entries.get(deviceId);
      if (current === undefined) return;
      current.delete(entry);
      if (current.size === 0) this.entries.delete(deviceId);
    };
  }

  /**
   * 关闭一台设备名下的全部通道。
   * @param deviceId - 设备标识。
   * @returns 按种类统计的关闭数量。
   */
  closeAll(deviceId: string): DeviceTransportCloseResult {
    const set = this.entries.get(deviceId);
    if (set === undefined) return { closed: 0, http: 0, websocket: 0, sse: 0 };
    this.entries.delete(deviceId);
    let http = 0;
    let websocket = 0;
    let sse = 0;
    for (const entry of [...set]) {
      if (entry.kind === 'http') http += 1;
      else if (entry.kind === 'websocket') websocket += 1;
      else sse += 1;
      entry.close();
    }
    return { closed: http + websocket + sse, http, websocket, sse };
  }

  /** 一台设备当前的通道数量。 */
  counts(deviceId: string): DeviceTransportCounts {
    const set = this.entries.get(deviceId);
    if (set === undefined) return { total: 0, http: 0, websocket: 0, sse: 0 };
    let http = 0;
    let websocket = 0;
    let sse = 0;
    for (const entry of set) {
      if (entry.kind === 'http') http += 1;
      else if (entry.kind === 'websocket') websocket += 1;
      else sse += 1;
    }
    return { total: http + websocket + sse, http, websocket, sse };
  }

  /** 有通道登记的设备数量。 */
  get size(): number {
    return this.entries.size;
  }
}
