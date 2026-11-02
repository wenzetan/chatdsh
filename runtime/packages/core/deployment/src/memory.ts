/**
 * 记忆组合包。
 *
 * 装载时构造真实的后端连接与探活扫描：连接保持长连，扫描按间隔向后端查询可用状态；卸载时
 * 停掉扫描并销毁连接。默认组合不装载本包，因此一个连接、一次扫描都不会发生。
 * @module @chatdsh/core-deployment/memory
 */

import { Agent, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { DeploymentError } from './errors.ts';
import type { BundleEndpoint, BundleMountHandle, CapabilityBundle } from './bundles.ts';

/** 记忆组合包的配置。 */
export interface MemoryBundleOptions {
  /** 后端地址，例如 Hindsight 的 `http://127.0.0.1:8889`。 */
  readonly backendUrl: string;
  /** 探活路径，缺省 `/version`。 */
  readonly healthPath?: string;
  /** 扫描间隔，单位毫秒，缺省 30000。 */
  readonly scanIntervalMs?: number;
  /** 单次请求的超时，单位毫秒，缺省 2000。 */
  readonly requestTimeoutMs?: number;
  /** 状态端点的前缀，缺省 `/chatdsh/deployment/memory`。 */
  readonly routePrefix?: string;
  /** 组合包标识，缺省 `memory-hindsight`。 */
  readonly id?: string;
}

/** 最近一次探活的结果。 */
interface ProbeState {
  reachable: boolean;
  lastProbeAt: number;
  probes: number;
  status: number;
}

/** 写一个 JSON 响应。 */
function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  response.end(body);
}

/**
 * 建立记忆组合包。
 * @param options - 后端地址、探活路径与扫描间隔。
 * @returns 组合包定义。
 */
export function createMemoryBundle(options: MemoryBundleOptions): CapabilityBundle {
  const id = options.id ?? 'memory-hindsight';
  const healthPath = options.healthPath ?? '/version';
  const scanIntervalMs = options.scanIntervalMs ?? 30_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 2_000;
  const routePrefix = options.routePrefix ?? '/chatdsh/deployment/memory';
  const backend = new URL(healthPath, options.backendUrl);
  const secure = backend.protocol === 'https:';
  const forward = secure ? httpsRequest : httpRequest;

  return {
    id,
    label: '记忆',
    resources: ['backend-connection', 'scan'],
    services: ['memory.recall', 'memory.write'],
    menus: [{ id: 'memory', label: '记忆' }],
    async mount(): Promise<BundleMountHandle> {
      const agent: Agent = secure ? new HttpsAgent({ keepAlive: true, maxSockets: 4 }) : new Agent({ keepAlive: true, maxSockets: 4 });
      const state: ProbeState = { reachable: false, lastProbeAt: 0, probes: 0, status: 0 };

      const probe = (): Promise<void> =>
        new Promise<void>((settle, fail) => {
          const request = forward(
            backend,
            { method: 'GET', agent, timeout: requestTimeoutMs, headers: { accept: 'application/json' } },
            (response) => {
              response.resume();
              response.on('end', () => {
                state.status = response.statusCode ?? 0;
                state.reachable = state.status >= 200 && state.status < 500;
                state.lastProbeAt = Date.now();
                state.probes += 1;
                settle();
              });
            }
          );
          request.on('timeout', () => {
            request.destroy(new Error('memory backend probe timeout'));
          });
          request.on('error', (error) => fail(error));
          request.end();
        });

      try {
        await probe();
      } catch {
        agent.destroy();
        throw new DeploymentError('memory-backend-unreachable', 'bundle', 502, '记忆后端在装载时不可达');
      }
      if (!state.reachable) {
        agent.destroy();
        throw new DeploymentError('memory-backend-unavailable', 'bundle', 502, '记忆后端没有给出可用应答');
      }

      const scan = setInterval(() => {
        void probe().catch(() => {
          state.reachable = false;
          state.lastProbeAt = Date.now();
        });
      }, scanIntervalMs);
      scan.unref();

      const endpoint: BundleEndpoint = {
        method: 'GET',
        path: `${routePrefix}/status`,
        transport: 'http',
        handle: (_request: IncomingMessage, response: ServerResponse) => {
          sendJson(response, 200, {
            bundle: id,
            backend: {
              reachable: state.reachable,
              lastProbeAt: state.lastProbeAt,
              probes: state.probes,
              status: state.status,
            },
          });
        },
      };

      return {
        endpoints: [endpoint],
        release: async () => {
          clearInterval(scan);
          agent.destroy();
        },
      };
    },
  };
}
