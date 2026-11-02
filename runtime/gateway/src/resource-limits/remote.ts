/**
 * 独立进程服务的状态探针。
 *
 * 容量报告在独立进程里测量控制平面自身的常驻内存与文件描述符，因此订阅数与分发耗时不能从
 * 本进程读，只能从服务的状态端点取。探针按固定间隔拉取状态并缓存，同步读取接口返回最近一次
 * 快照；重置分发采样走一次不等待的请求。
 * @module @chatdsh/gateway/resource-limits/remote
 */

import { request as httpRequest } from 'node:http';

/** 发一个单次连接请求并把响应解析成 JSON。 */
function getJson(url: string): Promise<unknown> {
  const parsed = new URL(url);
  return new Promise((settle, fail) => {
    const request = httpRequest({
      hostname: parsed.hostname,
      port: parsed.port,
      path: `${parsed.pathname}${parsed.search}`,
      method: 'GET',
      agent: false,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        if ((response.statusCode ?? 0) !== 200) {
          fail(new Error(`状态端点返回 ${String(response.statusCode)}`));
          return;
        }
        settle(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
      });
      response.on('error', fail);
    });
    request.on('error', fail);
    request.end();
  });
}

/** 发一个不等待结果的 POST。 */
function postNoWait(url: string): void {
  const parsed = new URL(url);
  const request = httpRequest({
    hostname: parsed.hostname,
    port: parsed.port,
    path: `${parsed.pathname}${parsed.search}`,
    method: 'POST',
    agent: false,
  }, (response) => {
    response.resume();
  });
  request.on('error', () => undefined);
  request.end();
}

/** 服务状态快照里与容量报告相关的部分。 */
export interface RemoteState {
  /** 事件流连接数。 */
  readonly sseConnections: number;
  /** 分发订阅数。 */
  readonly subscribers: number;
  /** 分发耗时采样，毫秒。 */
  readonly dispatchSamples: readonly number[];
  /** 当前排队条数。 */
  readonly queuedItems: number;
}

/** 远端探针。 */
export interface RemoteProbe {
  /** 立即刷新一次。 */
  refresh(): Promise<void>;
  /** 最近一次快照里的订阅数。 */
  subscriptionCount(): number;
  /** 最近一次快照里的分发耗时采样。 */
  dispatchSamplesMs(): readonly number[];
  /** 请求远端清空分发采样，不等待结果。 */
  resetDispatchSamples(): void;
  /** 最近一次快照。 */
  state(): RemoteState | undefined;
  /** 停止轮询。 */
  close(): void;
}

/**
 * 建立远端探针。
 * @param baseUrl - 服务地址。
 * @param intervalMs - 轮询间隔，缺省 25 毫秒。
 * @returns 探针。
 */
export function createRemoteProbe(baseUrl: string, intervalMs = 25): RemoteProbe {
  let latest: RemoteState | undefined;
  let stopped = false;
  const refresh = async (): Promise<void> => {
    const payload = await getJson(`${baseUrl}/chatdsh/gateway/resource/state`) as {
      governor?: { sseConnections?: number };
      fanout?: readonly { id: string; queuedItems: number }[];
      dispatch?: { samples?: readonly number[]; queuedItems?: number };
    };
    latest = {
      sseConnections: payload.governor?.sseConnections ?? 0,
      subscribers: payload.fanout?.length ?? 0,
      dispatchSamples: payload.dispatch?.samples ?? [],
      queuedItems: payload.dispatch?.queuedItems ?? 0,
    };
  };
  const timer = setInterval(() => {
    if (stopped) return;
    void refresh().catch(() => undefined);
  }, intervalMs);
  timer.unref();
  return {
    refresh,
    subscriptionCount: () => latest?.subscribers ?? 0,
    dispatchSamplesMs: () => latest?.dispatchSamples ?? [],
    resetDispatchSamples: () => {
      postNoWait(`${baseUrl}/chatdsh/gateway/resource/dispatch/reset`);
    },
    state: () => latest,
    close: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
