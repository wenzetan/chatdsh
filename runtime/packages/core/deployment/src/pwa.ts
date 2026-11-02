/**
 * PWA 组合包。
 *
 * 装载时登记清单、Service Worker 与离线页三个静态端点，打开订阅登记文件，并建立推送通道；
 * 卸载时关闭推送通道、清空订阅缓存并撤掉全部端点。静态内容由 `@chatdsh/client-pwa` 的真实
 * 生成函数提供，本模块只负责装载与释放。
 * @module @chatdsh/core-deployment/pwa
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Agent, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { dirname } from 'node:path';
import { DeploymentError } from './errors.ts';
import type { BundleEndpoint, BundleMountHandle, CapabilityBundle, PushMessage } from './bundles.ts';

/** PWA 静态内容；字段与 `@chatdsh/client-pwa` 的 `PwaStaticContent` 一致。 */
export interface PwaStaticContentLike {
  /** 应用清单地址。 */
  readonly manifestPath: string;
  /** 应用清单响应体。 */
  readonly manifestJson: string;
  /** 应用清单的响应内容类型。 */
  readonly manifestContentType: string;
  /** Service Worker 脚本地址。 */
  readonly serviceWorkerPath: string;
  /** Service Worker 脚本内容。 */
  readonly serviceWorkerSource: string;
  /** 离线回退页地址。 */
  readonly offlinePath: string;
  /** 离线回退页内容。 */
  readonly offlineHtml: string;
}

/** PWA 组合包的配置。 */
export interface PwaBundleOptions {
  /** 静态内容，来自 {@link PwaStaticContentLike}。 */
  readonly content: PwaStaticContentLike;
  /** 订阅登记的落盘位置。 */
  readonly subscriptionStorePath: string;
  /** 订阅端点的路径，缺省 `/chatdsh/deployment/pwa/subscriptions`。 */
  readonly subscriptionPath?: string;
  /** 单次推送的超时，单位毫秒，缺省 3000。 */
  readonly pushTimeoutMs?: number;
  /** 组合包标识，缺省 `pwa`。 */
  readonly id?: string;
}

/** 一条推送订阅。 */
interface PushSubscriptionRecord {
  readonly id: string;
  readonly endpoint: string;
  readonly createdAt: number;
}

/** 写一个 JSON 响应。 */
function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  response.end(body);
}

/** 读取请求体并解析 JSON；超限或解析失败时返回 `undefined`。 */
async function readJsonBody(request: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limit) return undefined;
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * 建立 PWA 组合包。
 * @param options - 静态内容、订阅登记位置与推送超时。
 * @returns 组合包定义。
 */
export function createPwaBundle(options: PwaBundleOptions): CapabilityBundle {
  const id = options.id ?? 'pwa';
  const subscriptionPath = options.subscriptionPath ?? '/chatdsh/deployment/pwa/subscriptions';
  const pushTimeoutMs = options.pushTimeoutMs ?? 3_000;

  return {
    id,
    label: 'PWA',
    resources: ['static-routes', 'subscription', 'push'],
    services: ['pwa.install', 'pwa.push'],
    menus: [{ id: 'pwa-install', label: '安装到主屏幕' }],
    async mount(): Promise<BundleMountHandle> {
      const storePath = options.subscriptionStorePath;
      mkdirSync(dirname(storePath), { recursive: true });
      const subscriptions = new Map<string, PushSubscriptionRecord>();
      try {
        const parsed = JSON.parse(readFileSync(storePath, 'utf8') as string) as unknown;
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (typeof item !== 'object' || item === null) continue;
            const record = item as Partial<PushSubscriptionRecord>;
            if (typeof record.id === 'string' && typeof record.endpoint === 'string' && typeof record.createdAt === 'number') {
              subscriptions.set(record.id, { id: record.id, endpoint: record.endpoint, createdAt: record.createdAt });
            }
          }
        }
      } catch {
        // 文件不存在时从空登记开始；装载失败由后续登记动作暴露。
      }
      const persist = (): void => {
        writeFileSync(storePath, JSON.stringify([...subscriptions.values()], null, 2), { mode: 0o600 });
      };

      const httpAgent = new Agent({ keepAlive: true, maxSockets: 4 });
      const httpsAgent = new HttpsAgent({ keepAlive: true, maxSockets: 4 });

      const endpoints: BundleEndpoint[] = [
        {
          method: 'GET',
          path: options.content.manifestPath,
          transport: 'http',
          handle: (_request: IncomingMessage, response: ServerResponse) => {
            response.writeHead(200, {
              'Content-Type': options.content.manifestContentType,
              'Content-Length': Buffer.byteLength(options.content.manifestJson),
              'Cache-Control': 'no-cache',
            });
            response.end(options.content.manifestJson);
          },
        },
        {
          method: 'GET',
          path: options.content.serviceWorkerPath,
          transport: 'http',
          handle: (_request: IncomingMessage, response: ServerResponse) => {
            response.writeHead(200, {
              'Content-Type': 'text/javascript; charset=utf-8',
              'Content-Length': Buffer.byteLength(options.content.serviceWorkerSource),
              'Service-Worker-Allowed': '/',
              'Cache-Control': 'no-cache',
            });
            response.end(options.content.serviceWorkerSource);
          },
        },
        {
          method: 'GET',
          path: options.content.offlinePath,
          transport: 'http',
          handle: (_request: IncomingMessage, response: ServerResponse) => {
            response.writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
              'Content-Length': Buffer.byteLength(options.content.offlineHtml),
              'Cache-Control': 'no-cache',
            });
            response.end(options.content.offlineHtml);
          },
        },
        {
          method: 'POST',
          path: subscriptionPath,
          transport: 'http',
          handle: async (request: IncomingMessage, response: ServerResponse) => {
            const payload = await readJsonBody(request, 16 * 1024);
            if (payload === undefined) {
              sendJson(response, 400, { error: 'invalid-subscription' });
              return;
            }
            const endpoint = typeof payload === 'object' && payload !== null ? (payload as { endpoint?: unknown }).endpoint : undefined;
            if (typeof endpoint !== 'string' || endpoint === '') {
              sendJson(response, 400, { error: 'subscription-endpoint-required' });
              return;
            }
            let parsed: URL;
            try {
              parsed = new URL(endpoint);
            } catch {
              sendJson(response, 400, { error: 'subscription-endpoint-invalid' });
              return;
            }
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
              sendJson(response, 400, { error: 'subscription-endpoint-invalid' });
              return;
            }
            const record: PushSubscriptionRecord = { id: randomUUID(), endpoint, createdAt: Date.now() };
            subscriptions.set(record.id, record);
            persist();
            sendJson(response, 201, { subscription: record });
          },
        },
        {
          method: 'DELETE',
          path: subscriptionPath,
          transport: 'http',
          handle: (request: IncomingMessage, response: ServerResponse) => {
            const queryAt = (request.url ?? '').indexOf('?');
            const query = queryAt === -1 ? new URLSearchParams() : new URLSearchParams((request.url ?? '').slice(queryAt));
            const target = query.get('id');
            if (target === null || !subscriptions.delete(target)) {
              sendJson(response, 404, { error: 'subscription-not-found' });
              return;
            }
            persist();
            sendJson(response, 200, { removed: true, id: target });
          },
        },
      ];

      const push = (message: PushMessage): Promise<{ readonly status: number }> =>
        new Promise<{ readonly status: number }>((settle, fail) => {
          const record = subscriptions.get(message.subscriptionId);
          if (record === undefined) {
            fail(new DeploymentError('push-subscription-missing', 'bundle', 404, '推送订阅不存在'));
            return;
          }
          const target = new URL(record.endpoint);
          const forward = target.protocol === 'https:' ? httpsRequest : httpRequest;
          const agent = target.protocol === 'https:' ? httpsAgent : httpAgent;
          const body = Buffer.from(JSON.stringify({ subscriptionId: record.id, payload: message.payload }), 'utf8');
          const request = forward(
            target,
            {
              method: 'POST',
              agent,
              timeout: pushTimeoutMs,
              headers: { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.length) },
            },
            (response) => {
              response.resume();
              response.on('end', () => {
                const status = response.statusCode ?? 0;
                if (status === 404 || status === 410) {
                  subscriptions.delete(record.id);
                  persist();
                  fail(new DeploymentError('push-endpoint-gone', 'bundle', 410, '推送端点已失效'));
                  return;
                }
                if (status < 200 || status >= 300) {
                  fail(new DeploymentError('push-delivery-failed', 'bundle', 502, '推送投递没有成功'));
                  return;
                }
                settle({ status });
              });
            }
          );
          request.on('timeout', () => {
            request.destroy(new Error('push delivery timeout'));
          });
          request.on('error', () => {
            fail(new DeploymentError('push-delivery-failed', 'bundle', 502, '推送通道不可用'));
          });
          request.end(body);
        });

      return {
        endpoints,
        push,
        release: async () => {
          clearSubscriptions(subscriptions);
          httpAgent.destroy();
          httpsAgent.destroy();
        },
      };
    },
  };
}

/** 清空订阅缓存；文件保留，重新装载时继续可用。 */
function clearSubscriptions(subscriptions: Map<string, PushSubscriptionRecord>): void {
  subscriptions.clear();
}
